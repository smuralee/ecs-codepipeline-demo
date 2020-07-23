# ECS blue/ green deployment 

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

 * `npm run build`   compile typescript to js
 * `npm run watch`   watch for changes and compile
 * `npm run test`    perform the jest unit tests
 * `cdk deploy`      deploy this stack to your default AWS account/region
 * `cdk diff`        compare deployed stack with current state
 * `cdk synth`       emits the synthesized CloudFormation template
 
## Execution steps

* Build the project - `npm run build`
* Bootstrap CDK - `cdk bootstrap`
* Deploy the CDK stack - `cdk deploy`
* Access the deployed version of the application using the output value of `BlueGreenUsingEcsStack.ecsBlueGreenLBDns`
* The demo application will have a blue background
* Push code to the code-commit repository 
    * Clone the GitHub reference repository - `git clone https://github.com/smuralee/nginx-example.git`
    * Clone the CodeCommit repository
        * You can get the repository URL from the output value of `BlueGreenUsingEcsStack.ecsBlueGreenCodeRepo`
        * Example: `git clone https://git-codecommit.us-east-1.amazonaws.com/v1/repos/demo-app`
    * Copy the code from GitHub repository to the local CodeCommit repository
    * Edit the `index.html`. We change the `background-color` to `green`
    ```html
        <head>
          <title>Demo Application</title>
        </head>
        <body style="background-color: green;">
          <h1 style="color: white; text-align: center;">
            Demo application - hosted with ECS
          </h1>
        </body>

    ```
    * Push the code to the CodeCommit repository
      ```
      git add .
      git commit -m "First commit"
      git push
      ``` 
* This will trigger the blue/green deployment for the ECS application
