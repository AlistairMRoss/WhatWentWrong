declare module "@aws-sdk/client-sns" {
  export class SNSClient {
    constructor(config: Record<string, unknown>);
    send(command: unknown): Promise<unknown>;
  }
  export class PublishCommand {
    constructor(input: {
      TopicArn?: string;
      Subject?: string;
      Message?: string;
    });
  }
}

declare module "@aws-sdk/client-dynamodb" {
  export class DynamoDBClient {
    constructor(config: Record<string, unknown>);
    send(command: unknown): Promise<{ Attributes?: Record<string, any> }>;
  }
  export class UpdateItemCommand {
    constructor(input: Record<string, unknown>);
  }
}

declare module "@aws-sdk/client-s3" {
  export class S3Client {
    constructor(config: Record<string, unknown>);
    send(command: unknown): Promise<{
      Body?: { transformToString(): Promise<string> };
    }>;
  }
  export class GetObjectCommand {
    constructor(input: { Bucket?: string; Key?: string });
  }
}
