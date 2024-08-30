import { CfnParameter, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import {
  Certificate,
  CertificateValidation,
} from 'aws-cdk-lib/aws-certificatemanager'
import {
  ISecurityGroup,
  InstanceClass,
  InstanceSize,
  InstanceType,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2'
import {
  AwsLogDriver,
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  ICluster,
} from 'aws-cdk-lib/aws-ecs'
import { FileSystem } from 'aws-cdk-lib/aws-efs'
import { CfnCacheCluster, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache'
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  IApplicationListener,
  ListenerAction,
  ListenerCondition,
  Protocol,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import { IRole, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import { ILogGroup, LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import {
  AuroraPostgresEngineVersion,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  IDatabaseCluster,
  ParameterGroup,
} from 'aws-cdk-lib/aws-rds'
import { ARecord, HostedZone } from 'aws-cdk-lib/aws-route53'
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets'
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'

const databaseUser = 'n8n'
const databaseName = 'n8n'
const port = 5678

interface N8NStackProps {
  region?: string;
}

export class N8NStack extends Stack {
  private readonly vpc: Vpc
  private readonly domainName: string
  private readonly hostedZoneId: string
  private readonly ecsCluster: ICluster
  private readonly database: IDatabaseCluster
  private readonly redis: CfnCacheCluster
  private readonly lbListener: IApplicationListener
  private readonly taskRole: IRole
  private readonly logGroup: ILogGroup

  private readonly secrets: {
    database: ISecret;
    encryption: ISecret;
    jwt: ISecret;
  }

  private readonly securityGroups: {
    database: ISecurityGroup;
    redis: ISecurityGroup;
    app: ISecurityGroup;
  }

  constructor(scope: Construct, id: string, props: N8NStackProps) {
    super(scope, id, {
      env: {
        region: props.region || 'us-east-1',
        account: process.env.CDK_DEFAULT_ACCOUNT,
      },
    })

    const domainName = new CfnParameter(this, 'DomainName', {
      type: 'String',
      description: 'The domain name that would point to the n8n instance',
    })

    const hostedZoneId = new CfnParameter(this, 'HostedZoneId', {
      type: 'String',
      description: 'The Route53 hosted zone to manage DNS entries',
    })

    this.domainName = domainName.valueAsString
    this.hostedZoneId = hostedZoneId.valueAsString

    const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      zoneName: this.domainName,
      hostedZoneId: this.hostedZoneId,
    })

    const certificate = new Certificate(this, 'Certificate', {
      certificateName: 'n8n',
      domainName: this.domainName,
      validation: CertificateValidation.fromDns(hostedZone),
    })

    const vpc = this.vpc = new Vpc(this, 'VPC', {
      vpcName: 'n8n',
      maxAzs: 2,
      natGateways: 2,
      subnetConfiguration: [
        { name: 'Public', subnetType: SubnetType.PUBLIC },
        { name: 'App', subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        { name: 'Internal', subnetType: SubnetType.PRIVATE_ISOLATED },
      ],
    })

    this.secrets = {
      database: new Secret(this, 'DatabaseSecret', {
        secretName: 'n8n-DatabaseSecret',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: databaseUser }),
          generateStringKey: 'password',
          excludePunctuation: true,
        },
      }),
      encryption: new Secret(this, 'EncryptionKey', {
        secretName: 'n8n-EncryptionKey',
        generateSecretString: {
          excludePunctuation: true,
        }
      }),
      jwt: new Secret(this, 'JWTSigningSecret', {
        secretName: 'n8n-JWTSigningSecret',
        generateSecretString: {
          excludePunctuation: true,
        }
      })
    }

    this.securityGroups = {
      database: new SecurityGroup(this, 'DatabaseSecurityGroup', {
        vpc,
        securityGroupName: 'n8n-Database',
        allowAllOutbound: true
      }),
      redis: new SecurityGroup(this, 'RedisSecurityGroup', {
        vpc,
        securityGroupName: 'n8n-Redis',
        allowAllOutbound: false,
      }),
      app: new SecurityGroup(this, 'AppSecurityGroup', {
        vpc,
        securityGroupName: 'n8n-App',
      }),
    }

    this.securityGroups.database.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(5432), // allow inbound traffic on port 5432 (postgres)
      'allow inbound traffic from anywhere to the db on port 5432'
    )

    const dbParameterGroup = new ParameterGroup(this, 'DBParameterGroup', {
      engine: DatabaseClusterEngine.auroraPostgres({ version: AuroraPostgresEngineVersion.VER_16_3 }),
      parameters: {
        'rds.force_ssl': '0',
      },
    })

    this.database = new DatabaseCluster(this, 'DatabaseCluster', {
      engine: DatabaseClusterEngine.auroraPostgres({ version: AuroraPostgresEngineVersion.VER_16_3 }),
      credentials: Credentials.fromSecret(this.secrets.database),
      instanceProps: {
        instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MEDIUM),
        vpcSubnets: {
          subnetType: SubnetType.PUBLIC,
        },
        vpc,
        publiclyAccessible: true,
        securityGroups: [this.securityGroups.database],
      },
      defaultDatabaseName: databaseName,
      removalPolicy: RemovalPolicy.DESTROY,
      parameterGroup: dbParameterGroup
    })

    const redisSubnetGroup = new CfnSubnetGroup(this, 'RedisSubnetGroup', {
      cacheSubnetGroupName: 'n8n',
      description: 'Cache SubnetGroup for n8n',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    })

    this.redis = new CfnCacheCluster(this, 'RedisCluster', {
      clusterName: 'n8n',
      engine: 'redis',
      engineVersion: '7.1',
      autoMinorVersionUpgrade: false,
      cacheNodeType: 'cache.t4g.medium',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [this.securityGroups.redis.securityGroupId],
    })
    this.redis.node.addDependency(redisSubnetGroup)

    const loadBalancer = new ApplicationLoadBalancer(this, 'LoadBalancer', {
      loadBalancerName: 'n8n',
      internetFacing: true,
      vpc,
      vpcSubnets: {
        onePerAz: true,
        subnetType: SubnetType.PUBLIC,
      },
      securityGroup: new SecurityGroup(this, 'LoadBalancerSecurityGroup', {
        vpc,
        securityGroupName: 'n8n-LoadBalancer',
      }),
    })
    loadBalancer
      .addListener('Redirector', { protocol: ApplicationProtocol.HTTP })
      .addAction('RedirectToHTTPS', {
        action: ListenerAction.redirect({
          port: '443',
          protocol: 'HTTPS',
          permanent: true,
        }),
      })

    new ARecord(this, 'ALBRecord', {
      recordName: this.domainName,
      zone: hostedZone,
      target: {
        aliasTarget: new LoadBalancerTarget(loadBalancer),
      },
    })

    this.lbListener = loadBalancer.addListener('Listener', {
      protocol: ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultAction: ListenerAction.fixedResponse(404),
    })

    // TODO: enable capacity-providers to use spot-instances for workers
    this.ecsCluster = new Cluster(this, 'Cluster', { vpc, clusterName: 'n8n', containerInsights: true })

    this.taskRole = new Role(this, 'AppTaskRole', {
      roleName: 'n8n-ECSTask',
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
    })

    this.logGroup = new LogGroup(this, 'AppLogs', {
      logGroupName: '/n8n/logs',
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    this.createService('webhook')
    this.createService('main')
    this.createService('worker')


  }  private createService(serviceName: 'main' | 'worker' | 'webhook') {
    const taskDefinition = new FargateTaskDefinition(
      this,
      `TaskDefinition-${serviceName}`,
      {
        family: `n8n-${serviceName}`,
        taskRole: this.taskRole,
        executionRole: this.taskRole,
        cpu: 2048,
        memoryLimitMiB: serviceName === 'main' ? 4096 : 4096,
      }
    )

    const container = taskDefinition.addContainer(`n8n-${serviceName}`, {
      image: ContainerImage.fromRegistry('gsogol/mabbly:1.57.1'),
      command: [...(serviceName === 'main' ? ['start'] : serviceName === 'worker' ? ['worker', '--concurrency=20'] : [serviceName])],
      environment: {
        N8N_DIAGNOSTICS_ENABLED: 'true',
        DB_TYPE: 'postgresdb',
        DB_POSTGRESDB_HOST: this.database.clusterEndpoint.hostname,
        DB_POSTGRESDB_PORT: this.database.clusterEndpoint.port.toString(),
        DB_POSTGRESDB_DATABASE: databaseName,
        DB_POSTGRESDB_USER: databaseUser,
        DB_POSTGRESDB_PASSWORD: this.secrets.database
          .secretValueFromJson('password')
          .unsafeUnwrap(),
        N8N_ENCRYPTION_KEY: this.secrets.encryption.secretValue.unsafeUnwrap(),
        N8N_USER_MANAGEMENT_JWT_SECRET: this.secrets.jwt.secretValue.unsafeUnwrap(),
        EXECUTIONS_PROCESS: 'main',
        EXECUTIONS_MODE: 'queue',
        N8N_DISABLE_PRODUCTION_MAIN_PROCESS: 'true',
        QUEUE_BULL_REDIS_HOST: this.redis.attrRedisEndpointAddress,
        QUEUE_HEALTH_CHECK_ACTIVE: 'true',
        N8N_PUSH_BACKEND: 'websocket',
        WEBHOOK_URL: `https://${this.domainName}`,
        N8N_BLOCK_ENV_ACCESS_IN_NODE: 'true',
      },
      logging: new AwsLogDriver({
        logGroup: this.logGroup,
        streamPrefix: `/${serviceName}`,
      }),
      healthCheck: {
        command: [
          'CMD-SHELL',
          // `curl --fail http://localhost:${port}/healthz || exit 1`,
          'exit 0',
        ],
        retries: 10,
      },
      portMappings: [
        {
          containerPort: port,
          hostPort: port,
        },
      ],
    })

    const service = new FargateService(this, `Service-${serviceName}`, {
      serviceName: `n8n-${serviceName}`,
      cluster: this.ecsCluster,
      desiredCount: serviceName === 'main' ? 1 : serviceName === 'webhook' ? 1 : 2, // TODO: auto-scale workers
      taskDefinition,
      securityGroups: [this.securityGroups.app],
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
    })

    service.connections.allowTo(this.securityGroups.redis, Port.tcp(6379))
    service.connections.allowTo(this.securityGroups.database, Port.tcp(5432))
    service.connections.allowFromAnyIpv4(Port.tcp(port))

    if (serviceName !== 'worker') {
      this.lbListener.addTargets(`n8n-${serviceName}`, {
        targetGroupName: serviceName,
        protocol: ApplicationProtocol.HTTP,
        port,
        priority: serviceName === 'webhook' ? 10 : 20,
        conditions: [
          ListenerCondition.hostHeaders([this.domainName]),
          ...(serviceName === 'webhook'
            ? [
              ListenerCondition.pathPatterns([
                '/webhook/*',
                '/webhook-waiting/*',
              ]),
            ]
            : []),
        ],
        targets: [service],
        healthCheck: {
          protocol: Protocol.HTTP,
          path: '/healthz',
          healthyThresholdCount: 3,
          unhealthyThresholdCount: 10,
          interval: Duration.seconds(30),
        },
        deregistrationDelay: Duration.seconds(10),
      })
    }
  }
}