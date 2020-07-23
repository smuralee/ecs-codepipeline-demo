import * as cdk from '@aws-cdk/core';
import {CfnOutput, CustomResource, Duration, RemovalPolicy} from '@aws-cdk/core';
import {ApplicationProtocol, TargetType} from "@aws-cdk/aws-elasticloadbalancingv2";
import {ContainerImage, DeploymentControllerType, Protocol} from "@aws-cdk/aws-ecs";
import {AnyPrincipal, Effect, ManagedPolicy, ServicePrincipal} from "@aws-cdk/aws-iam";
import {BuildEnvironmentVariableType, ComputeType} from "@aws-cdk/aws-codebuild";
import * as path from "path";
import {Port} from "@aws-cdk/aws-ec2";
import {BlockPublicAccess, BucketEncryption} from "@aws-cdk/aws-s3";
import {EcsDeploymentConfig} from "@aws-cdk/aws-codedeploy";
import codeCommit = require('@aws-cdk/aws-codecommit');
import codeBuild = require("@aws-cdk/aws-codebuild");
import codeDeploy = require("@aws-cdk/aws-codedeploy");
import iam = require("@aws-cdk/aws-iam");
import ec2 = require('@aws-cdk/aws-ec2');
import ecs = require('@aws-cdk/aws-ecs');
import elb = require("@aws-cdk/aws-elasticloadbalancingv2");
import log = require("@aws-cdk/aws-logs");
import ecr = require("@aws-cdk/aws-ecr");
import s3 = require("@aws-cdk/aws-s3");
import codePipelineActions = require("@aws-cdk/aws-codepipeline-actions");
import targets = require('@aws-cdk/aws-events-targets');


import lambda = require('@aws-cdk/aws-lambda');
import codePipeline = require("@aws-cdk/aws-codepipeline");


export class BlueGreenUsingEcsStack extends cdk.Stack {

    static readonly ECS_DEPLOYMENT_GROUP_NAME = "DemoAppECSBlueGreen";
    static readonly ECS_DEPLOYMENT_CONFIG_NAME = "CodeDeployDefault.ECSLinear10PercentEvery1Minutes";

    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // =============================================================================
        // ECR and CodeCommit repositories for the Blue/ Green deployment
        // =============================================================================

        // ECR repository for the docker images
        const ecrRepo = new ecr.Repository(this, 'demo-app', {
            imageScanOnPush: true,
            removalPolicy: RemovalPolicy.DESTROY
        });

        // CodeCommit repository for storing the source code
        const codeRepo = new codeCommit.Repository(this, "demoAppRepo", {
            repositoryName: "demo-app",
            description: "Demo app hosted on NGINX"
        });

        // =============================================================================
        // CODE BUILD and ECS TASK ROLES for the Blue/ Green deployment
        // =============================================================================

        // IAM role for the Code Build project
        const codeBuildServiceRole = new iam.Role(this, "codeBuildServiceRole", {
            assumedBy: new ServicePrincipal('codebuild.amazonaws.com')
        });

        const inlinePolicyForCodeBuild = new iam.PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:InitiateLayerUpload",
                "ecr:UploadLayerPart",
                "ecr:CompleteLayerUpload",
                "ecr:PutImage"
            ],
            resources: ["*"]
        });

        codeBuildServiceRole.addToPolicy(inlinePolicyForCodeBuild);

        // ECS task role
        const ecsTaskRole = new iam.Role(this, "ecsTaskRoleForWorkshop", {
            assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com')
        });
        ecsTaskRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"));


        // =============================================================================
        // CODE DEPLOY APPLICATION for the Blue/ Green deployment
        // =============================================================================

        // Creating the code deploy application
        const codeDeployApplication = new codeDeploy.EcsApplication(this, "demoAppCodeDeploy");

        // Creating the code deploy service role
        const codeDeployServiceRole = new iam.Role(this, "codeDeployServiceRole", {
            assumedBy: new ServicePrincipal('codedeploy.amazonaws.com')
        });
        codeDeployServiceRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("AWSCodeDeployRoleForECS"));

        // IAM role for custom lambda function
        const customLambdaServiceRole = new iam.Role(this, "codeDeployCustomLambda", {
            assumedBy: new ServicePrincipal('lambda.amazonaws.com')
        });

        const inlinePolicyForLambda = new iam.PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                "iam:PassRole",
                "sts:AssumeRole",
                "codedeploy:List*",
                "codedeploy:Get*",
                "codedeploy:UpdateDeploymentGroup",
                "codedeploy:CreateDeploymentGroup",
                "codedeploy:DeleteDeploymentGroup"
            ],
            resources: ["*"]
        });

        customLambdaServiceRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'))
        customLambdaServiceRole.addToPolicy(inlinePolicyForLambda);

        // Custom resource to create the deployment group
        const createDeploymentGroupLambda = new lambda.Function(this, 'createDeploymentGroupLambda', {
            code: lambda.Code.fromAsset(
                path.join(__dirname, 'custom_resources'),
                {
                    exclude: ["**", "!create_deployment_group.py"]
                }),
            runtime: lambda.Runtime.PYTHON_3_8,
            handler: 'create_deployment_group.handler',
            role: customLambdaServiceRole,
            description: "Custom resource to create deployment group",
            memorySize: 128,
            timeout: cdk.Duration.seconds(60)
        });

        // =============================================================================
        // VPC, ECS Cluster, ELBs and Target groups for the Blue/ Green deployment
        // =============================================================================

        // Creating the VPC
        const vpc = new ec2.Vpc(this, 'vpcForECSCluster');

        // Creating a ECS cluster
        const cluster = new ecs.Cluster(this, 'ecsClusterForWorkshop', {vpc});

        // Creating an application load balancer, listener and two target groups for Blue/Green deployment
        const alb = new elb.ApplicationLoadBalancer(this, "alb", {
            vpc: vpc,
            internetFacing: true
        });
        const albListener = alb.addListener('albListener', {
            port: 80
        });
        albListener.connections.allowDefaultPortFromAnyIpv4('Allow traffic from everywhere');

        // Target group 1
        const blueGroup = new elb.ApplicationTargetGroup(this, "blueGroup", {
            vpc: vpc,
            protocol: ApplicationProtocol.HTTP,
            port: 80,
            targetType: TargetType.IP,
            healthCheck: {
                path: "/",
                timeout: Duration.seconds(10),
                interval: Duration.seconds(15)
            }
        });

        // Target group 2
        const greenGroup = new elb.ApplicationTargetGroup(this, "greenGroup", {
            vpc: vpc,
            protocol: ApplicationProtocol.HTTP,
            port: 80,
            targetType: TargetType.IP,
            healthCheck: {
                path: "/",
                timeout: Duration.seconds(10),
                interval: Duration.seconds(15)
            }
        });

        // Registering the blue target group with the load balancer
        albListener.addTargetGroups("blueTarget", {
            targetGroups: [blueGroup]
        });

        // ================================================================================================
        // DUMMY TASK DEFINITION for the initial service creation
        // This is required for the service being made available to create the CodeDeploy Deployment Group
        // ================================================================================================
        const sampleTaskDefinition = new ecs.FargateTaskDefinition(this, "sampleTaskDefn", {
            family: "sample-app",
            cpu: 256,
            memoryLimitMiB: 1024,
            taskRole: ecsTaskRole,
            executionRole: ecsTaskRole
        });
        const sampleContainerDefn = sampleTaskDefinition.addContainer("sample-app", {
            image: ecs.ContainerImage.fromRegistry("smuralee/nginx"),
            logging: new ecs.AwsLogDriver({
                logGroup: new log.LogGroup(this, "sampleAppLogGroup", {
                    logGroupName: "/ecs/sample-app",
                    removalPolicy: RemovalPolicy.DESTROY
                }),
                streamPrefix: "sample-app"
            }),
            dockerLabels: {
                name: "sample-app"
            }
        });
        sampleContainerDefn.addPortMappings({
            containerPort: 80,
            protocol: Protocol.TCP
        });

        // ================================================================================================
        // ECS task definition using ECR image
        // Will be used by the CODE DEPLOY for Blue/Green deployment
        // ================================================================================================
        const taskDefinition = new ecs.FargateTaskDefinition(this, "appTaskDefn", {
            family: "demo-app",
            cpu: 256,
            memoryLimitMiB: 1024,
            taskRole: ecsTaskRole,
            executionRole: ecsTaskRole
        });
        const containerDefinition = taskDefinition.addContainer("demo-app", {
            image: ContainerImage.fromEcrRepository(ecrRepo, "latest"),
            logging: new ecs.AwsLogDriver({
                logGroup: new log.LogGroup(this, "demoAppLogGroup", {
                    logGroupName: "/ecs/demo-app",
                    removalPolicy: RemovalPolicy.DESTROY
                }),
                streamPrefix: "demo-app"
            }),
            dockerLabels: {
                name: "demo-app"
            }
        });
        containerDefinition.addPortMappings({
            containerPort: 80,
            protocol: Protocol.TCP
        });

        // =============================================================================
        // ECS SERVICE for the Blue/ Green deployment
        // =============================================================================
        const demoAppService = new ecs.FargateService(this, "demoAppService", {
            cluster: cluster,
            taskDefinition: sampleTaskDefinition,
            healthCheckGracePeriod: Duration.seconds(10),
            desiredCount: 3,
            deploymentController: {
                type: DeploymentControllerType.CODE_DEPLOY
            },
            serviceName: "demo-app"
        });

        demoAppService.connections.allowFrom(alb, Port.tcp(80))
        demoAppService.attachToApplicationTargetGroup(blueGroup);

        // =============================================================================
        // CODE DEPLOY - Deployment Group CUSTOM RESOURCE for the Blue/ Green deployment
        // =============================================================================

        new CustomResource(this, 'customEcsDeploymentGroup', {
            serviceToken: createDeploymentGroupLambda.functionArn,
            properties: {
                ApplicationName: codeDeployApplication.applicationName,
                DeploymentGroupName: BlueGreenUsingEcsStack.ECS_DEPLOYMENT_GROUP_NAME,
                DeploymentConfigName: BlueGreenUsingEcsStack.ECS_DEPLOYMENT_CONFIG_NAME,
                ServiceRoleArn: codeDeployServiceRole.roleArn,
                BlueTargetGroup: blueGroup.targetGroupName,
                GreenTargetGroup: greenGroup.targetGroupName,
                ProdListenerArn: albListener.listenerArn,
                EcsClusterName: cluster.clusterName,
                EcsServiceName: demoAppService.serviceName,
                TerminationWaitTime: "30"
            }
        });

        const ecsDeploymentGroup = codeDeploy.EcsDeploymentGroup.fromEcsDeploymentGroupAttributes(this, "ecsDeploymentGroup", {
            application: codeDeployApplication,
            deploymentGroupName: BlueGreenUsingEcsStack.ECS_DEPLOYMENT_GROUP_NAME,
            deploymentConfig: EcsDeploymentConfig.fromEcsDeploymentConfigName(this, "ecsDeploymentConfig", BlueGreenUsingEcsStack.ECS_DEPLOYMENT_CONFIG_NAME)
        });


        // =============================================================================
        // CODE BUILD PROJECT for the Blue/ Green deployment
        // =============================================================================

        // Creating the code build project
        const demoAppCodeBuild = new codeBuild.Project(this, "demoAppCodeBuild", {
            role: codeBuildServiceRole,
            description: "Code build project for the demo-app",
            environment: {
                buildImage: codeBuild.LinuxBuildImage.STANDARD_4_0,
                computeType: ComputeType.SMALL,
                privileged: true,
                environmentVariables: {
                    REPOSITORY_URI: {
                        value: ecrRepo.repositoryUri,
                        type: BuildEnvironmentVariableType.PLAINTEXT
                    },
                    TASK_EXECUTION_ARN: {
                        value: ecsTaskRole.roleArn,
                        type: BuildEnvironmentVariableType.PLAINTEXT
                    },
                    TASK_DEFN_ARN: {
                        value: taskDefinition.taskDefinitionArn,
                        type: BuildEnvironmentVariableType.PLAINTEXT
                    }
                }
            },
            source: codeBuild.Source.codeCommit({
                repository: codeRepo
            })
        });

        // =============================================================================
        // CODE PIPELINE for Blue/Green ECS deployment
        // =============================================================================

        const codePipelineServiceRole = new iam.Role(this, "codePipelineServiceRole", {
            assumedBy: new ServicePrincipal('codepipeline.amazonaws.com')
        });

        const inlinePolicyForCodePipeline = new iam.PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                "iam:PassRole",
                "sts:AssumeRole",
                "codecommit:Get*",
                "codecommit:List*",
                "codecommit:GitPull",
                "codecommit:UploadArchive",
                "codecommit:CancelUploadArchive",
                "codebuild:BatchGetBuilds",
                "codebuild:StartBuild",
                "codedeploy:CreateDeployment",
                "codedeploy:Get*",
                "codedeploy:RegisterApplicationRevision",
                "s3:Get*",
                "s3:List*",
                "s3:PutObject"
            ],
            resources: ["*"]
        });

        codePipelineServiceRole.addToPolicy(inlinePolicyForCodePipeline);

        const sourceArtifact = new codePipeline.Artifact('sourceArtifact');
        const buildArtifact = new codePipeline.Artifact('buildArtifact');

        // S3 bucket for storing the code pipeline artifacts
        const demoAppArtifactsBucket = new s3.Bucket(this, "demoAppArtifactsBucket", {
            encryption: BucketEncryption.S3_MANAGED,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            removalPolicy: RemovalPolicy.DESTROY
        });

        // S3 bucket policy for the code pipeline artifacts
        const denyUnEncryptedObjectUploads = new iam.PolicyStatement({
            effect: Effect.DENY,
            actions: ["s3:PutObject"],
            principals: [new AnyPrincipal()],
            resources: [demoAppArtifactsBucket.bucketArn.concat("/*")],
            conditions: {
                StringNotEquals: {
                    "s3:x-amz-server-side-encryption": "aws:kms"
                }
            }
        });

        const denyInsecureConnections = new iam.PolicyStatement({
            effect: Effect.DENY,
            actions: ["s3:*"],
            principals: [new AnyPrincipal()],
            resources: [demoAppArtifactsBucket.bucketArn.concat("/*")],
            conditions: {
                Bool: {
                    "aws:SecureTransport": "false"
                }
            }
        });

        demoAppArtifactsBucket.addToResourcePolicy(denyUnEncryptedObjectUploads);
        demoAppArtifactsBucket.addToResourcePolicy(denyInsecureConnections);


        const ecsBlueGreenPipeline = new codePipeline.Pipeline(this, "ecsBlueGreen", {
            role: codePipelineServiceRole,
            artifactBucket: demoAppArtifactsBucket,
            stages: [
                {
                    stageName: 'Source',
                    actions: [
                        new codePipelineActions.CodeCommitSourceAction({
                            actionName: 'Source',
                            repository: codeRepo,
                            output: sourceArtifact,
                        }),
                    ]
                },
                {
                    stageName: 'Build',
                    actions: [
                        new codePipelineActions.CodeBuildAction({
                            actionName: 'Build',
                            project: demoAppCodeBuild,
                            input: sourceArtifact,
                            outputs: [buildArtifact]
                        })
                    ]
                },
                {
                    stageName: 'Deploy',
                    actions: [
                        new codePipelineActions.CodeDeployEcsDeployAction({
                            actionName: 'Deploy',
                            deploymentGroup: ecsDeploymentGroup,
                            appSpecTemplateInput: buildArtifact,
                            taskDefinitionTemplateInput: buildArtifact,
                        })
                    ]
                }
            ]
        });

        // Event rule for onCommit of policyRepo to trigger code pipeline
        codeRepo.onCommit('OnCommit', {
            branches: [
                "master"
            ],
            target: new targets.CodePipeline(ecsBlueGreenPipeline),
            description: "Trigger Blue/Green deployment on code commit"
        });


        // =============================================================================
        // Export the outputs
        // =============================================================================
        new CfnOutput(this, "ecsBlueGreenCodeRepo", {
            description: "Demo app code commit repository",
            exportName: "ecsBlueGreenDemoAppRepo",
            value: codeRepo.repositoryCloneUrlHttp
        });

        new CfnOutput(this, "ecsBlueGreenLBDns", {
            description: "Load balancer DNS",
            exportName: "ecsBlueGreenLBDns",
            value: alb.loadBalancerDnsName
        });


    }
}
