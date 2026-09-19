/**
 * MinIO 对象存储薄封装。技能正文按 {skill_no}/{version}.md 存在技能桶里，
 * worker 只读不写。客户端惰性单例：首次用到才建，无技能场景不白建连接。
 */
import { Client } from "minio";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

let client: Client | undefined;

function getClient(): Client {
  if (client === undefined) {
    client = new Client({
      // minio 包的 endPoint 只填主机，端口单独走 port。
      endPoint: process.env.MINIO_ENDPOINT ?? "127.0.0.1",
      port: positiveInteger(process.env.MINIO_PORT, 9000),
      useSSL: (process.env.MINIO_USE_SSL ?? "false") === "true",
      accessKey: process.env.MINIO_ACCESS_KEY ?? "local_dev",
      secretKey: process.env.MINIO_SECRET_KEY ?? "local_dev_2026",
    });
  }
  return client;
}

/** 按对象 key 取技能正文原始字节；桶固定读 MINIO_SKILL_BUCKET。 */
export async function getSkillObject(objectKey: string): Promise<Buffer> {
  const bucket = process.env.MINIO_SKILL_BUCKET ?? "ap-skills";
  const stream = await getClient().getObject(bucket, objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
