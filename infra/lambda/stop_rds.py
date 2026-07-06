# 毎日 05:00 JST に RDS (pl-app-db) を停止する Lambda（ADR-038 の停止運用を自動化）
# 目的:
#  1. 学習後の止め忘れ防止（夜に自動でオフ）
#  2. 「停止したRDSは7日後にAWSが自動再起動する」仕様への対策（翌朝には止め直される）
# EventBridge ルール: cron(0 20 * * ? *) UTC = 05:00 JST
import boto3

rds = boto3.client("rds")
DB_ID = "pl-app-db"


def handler(event, context):
    status = rds.describe_db_instances(DBInstanceIdentifier=DB_ID)["DBInstances"][0][
        "DBInstanceStatus"
    ]
    if status == "available":
        rds.stop_db_instance(DBInstanceIdentifier=DB_ID)
        return {"action": "stopped", "was": status}
    # 既に停止中・起動中・停止処理中などは何もしない（冪等）
    return {"action": "skipped", "was": status}
