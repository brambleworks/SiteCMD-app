use super::super::*;

#[test]
fn detects_fetch_of_request_accessor_url() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "src/routes/proxy.js",
        r#"
                const express = require("express");
                const router = express.Router();

                router.get("/proxy", async (req, res) => {
                  const upstream = await fetch(req.query.url);
                  res.send(await upstream.text());
                });

                module.exports = router;
            "#,
    );
    let report = audit_project(temp.path()).unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.id.starts_with("user-controlled-fetch:")),
        "fetch(req.query.url) is a user-controlled fetch"
    );

    let temp_py = TempDir::new().unwrap();
    write_file(
        temp_py.path(),
        "app/api/proxy.py",
        r#"import requests
from flask import request

@app.route("/proxy")
def proxy():
    upstream = requests.get(request.args["url"])
    return upstream.text
"#,
    );
    let report_py = audit_project(temp_py.path()).unwrap();
    assert!(
        report_py
            .issues
            .iter()
            .any(|issue| issue.id.starts_with("user-controlled-fetch:")),
        "requests.get(request.args[\"url\"]) is a user-controlled fetch"
    );
}

#[test]
fn detects_open_cors_with_credentials() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "app/api/session/route.ts",
        r#"
                export async function GET() {
                  return new Response("ok", {
                    headers: {
                      "Access-Control-Allow-Origin": "*",
                      "Access-Control-Allow-Credentials": "true"
                    }
                  });
                }
            "#,
    );

    let report = audit_project(temp.path()).unwrap();
    let issue = report
        .issues
        .iter()
        .find(|issue| issue.id.starts_with("cors-credentials-wildcard:"))
        .expect("wildcard credentialed CORS finding");
    assert_eq!(issue.severity, Severity::Medium);
    assert_eq!(
        issue.confidence,
        crate::checks::IssueConfidence::NeedsReview
    );
    assert!(issue.description.contains("browser blocks"));
}

#[test]
fn detects_fastapi_cors_wildcard_with_credentials() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "lightrag/api/lightrag_server.py",
        r#"from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

def get_cors_origins():
    if global_args.cors_origins == "*":
        return ["*"]
    return global_args.cors_origins.split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(),
    allow_credentials=True,
)
"#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.id.starts_with("cors-credentials-wildcard:")),
        "FastAPI's wildcard and credential settings should be recognized: {:?}",
        report
            .issues
            .iter()
            .map(|issue| &issue.id)
            .collect::<Vec<_>>()
    );
}

#[test]
fn skips_fastapi_cors_fix_and_explanatory_comments() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "lightrag/api/lightrag_server.py",
        r#"from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

def get_cors_origins():
    if global_args.cors_origins == "*":
        return ["*"]
    return global_args.cors_origins.split(",")

cors_origins = get_cors_origins()
# Never combine Access-Control-Allow-Origin: * with
# Access-Control-Allow-Credentials: true.
allow_credentials = cors_origins != ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=allow_credentials,
)
"#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(
        !report
            .issues
            .iter()
            .any(|issue| issue.id.starts_with("cors-credentials-wildcard:")),
        "the guarded setting and its comment should not look vulnerable: {:?}",
        report
            .issues
            .iter()
            .map(|issue| &issue.id)
            .collect::<Vec<_>>()
    );
}

#[test]
fn detects_fastapi_cors_wildcard_and_credentials_from_config_defaults() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "glances/outputs/glances_restful_api.py",
        r#"from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

self._app = FastAPI()
self._app.add_middleware(
    CORSMiddleware,
    allow_origins=config.get_list_value('outputs', 'cors_origins', default=["*"]),
    allow_credentials=config.get_bool_value('outputs', 'cors_credentials', default=True),
)
"#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.id.starts_with("cors-credentials-wildcard:")),
        "insecure FastAPI configuration defaults should be recognized: {:?}",
        report
            .issues
            .iter()
            .map(|issue| &issue.id)
            .collect::<Vec<_>>()
    );
}

#[test]
fn skips_guarded_fastapi_cors_config_and_warning_text() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "glances/outputs/glances_restful_api.py",
        r#"from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

self._app = FastAPI()
cors_origins = config.get_list_value('outputs', 'cors_origins', default=["*"])
cors_credentials = config.get_bool_value('outputs', 'cors_credentials', default=False)
if cors_origins == ["*"] and cors_credentials:
    logger.warning(
        "CORS: allow_origins=['*'] combined with allow_credentials=True is insecure."
    )
    cors_credentials = False

self._app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=cors_credentials,
)
"#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(
        !report
            .issues
            .iter()
            .any(|issue| issue.id.starts_with("cors-credentials-wildcard:")),
        "guarded configuration and warning text should stay quiet: {:?}",
        report
            .issues
            .iter()
            .map(|issue| &issue.id)
            .collect::<Vec<_>>()
    );
}

#[test]
fn detects_multi_write_flow_without_transaction_and_missing_test() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "app/api/checkout/route.ts",
        r#"
                import { PrismaClient } from "@prisma/client";

                export async function POST() {
                  const prisma = new PrismaClient();
                  await prisma.order.create({ data: { status: "pending" } });
                  await prisma.auditLog.create({ data: { action: "checkout" } });
                  return Response.json({ ok: true });
                }
            "#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.id.starts_with("multi-write-no-transaction:")));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.id.starts_with("critical-path-no-test:")));
}

#[test]
fn skips_missing_test_for_rust_routes_with_inline_tests() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "src/api/jobs.rs",
        r#"
                #[tracing::instrument]
                pub async fn create_job() {
                    let client = openai::Client::new("test");
                    let _ = client.responses();
                }

                #[cfg(test)]
                mod tests {
                    #[test]
                    fn create_job_handles_failures() {
                        assert!(true);
                    }
                }
            "#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(!report
        .issues
        .iter()
        .any(|issue| issue.id.starts_with("critical-path-no-test:")));
}

#[test]
fn detects_sensitive_route_missing_authz() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "app/api/admin/users/route.ts",
        r#"
                import { getServerSession } from "next-auth";

                export async function POST(request: Request) {
                  const session = await getServerSession();
                  if (!session) return new Response("nope", { status: 401 });
                  const body = await request.json();
                  return Response.json({ email: body.email });
                }
            "#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.id.starts_with("sensitive-authz:")));
}

#[test]
fn detects_sensitive_server_action_missing_auth_and_validation() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "app/billing/actions.ts",
        r#"
                "use server";

                import Stripe from "stripe";

                const stripe = new Stripe(process.env.STRIPE_SECRET!, { apiVersion: "2024-06-20" });

                export async function startCheckout(formData: FormData) {
                  const priceId = formData.get("priceId");
                  const session = await stripe.checkout.sessions.create({
                    mode: "subscription",
                    line_items: [{ price: priceId, quantity: 1 }],
                    success_url: "https://example.com/success",
                    cancel_url: "https://example.com/cancel",
                  });

                  return session.url;
                }
            "#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.id.starts_with("sensitive-auth:")));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.id.starts_with("request-validation:")));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.id.starts_with("stripe-user-controlled-price:")));
}

#[test]
fn skips_sensitive_server_action_findings_when_guarded_and_validated() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "app/billing/actions.ts",
        r#"
                "use server";

                import { z } from "zod";
                import Stripe from "stripe";
                import { auth } from "@/auth";

                const stripe = new Stripe(process.env.STRIPE_SECRET!, { apiVersion: "2024-06-20" });
                const PRICE_MAP = {
                  starter: "price_starter",
                  pro: "price_pro",
                } as const;

                export async function startCheckout(formData: FormData) {
                  const session = await auth();
                  if (!session?.user?.isAdmin) throw new Error("forbidden");

                  const input = z.object({
                    plan: z.enum(["starter", "pro"]),
                    requestId: z.string().min(8),
                  }).parse({
                    plan: formData.get("plan"),
                    requestId: formData.get("requestId"),
                  });

                  const checkout = await stripe.checkout.sessions.create({
                    mode: "subscription",
                    line_items: [{ price: PRICE_MAP[input.plan], quantity: 1 }],
                    success_url: "https://example.com/success",
                    cancel_url: "https://example.com/cancel",
                  }, {
                    idempotencyKey: input.requestId,
                  });

                  return checkout.url;
                }
            "#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(!report
        .issues
        .iter()
        .any(|issue| issue.id.starts_with("sensitive-auth:")));
    assert!(!report
        .issues
        .iter()
        .any(|issue| issue.id.starts_with("request-validation:")));
    assert!(!report
        .issues
        .iter()
        .any(|issue| issue.id.starts_with("stripe-user-controlled-price:")));
}

const SINGLE_WRITE_ACTIONS: &str = r#""use server";

import { createClient } from "@/lib/supabase/server";

export async function submitTip(formData: FormData) {
  const supabase = await createClient();
  await supabase.from("tips").insert({ text: formData.get("text") });
  return { success: true };
}

export async function approveTip(tipId: string) {
  const supabase = await createClient();
  await supabase.from("tips").update({ status: "approved" }).eq("id", tipId);
  return { success: true };
}

export async function rejectTip(tipId: string) {
  const supabase = await createClient();
  await supabase.from("tips").update({ status: "rejected" }).eq("id", tipId);
  return { success: true };
}
"#;

#[test]
fn skips_multi_write_finding_when_each_handler_performs_one_write() {
    let temp = TempDir::new().unwrap();
    write_file(temp.path(), "lib/actions/tips.ts", SINGLE_WRITE_ACTIONS);

    let report = audit_project(temp.path()).unwrap();
    assert!(
        !report
            .issues
            .iter()
            .any(|issue| issue.id.starts_with("multi-write-no-transaction:")),
        "one write per exported handler shares no invariant, got {:?}",
        report.issues.iter().map(|i| &i.id).collect::<Vec<_>>()
    );
}

#[test]
fn detects_multi_write_inside_one_handler_among_single_write_siblings() {
    let temp = TempDir::new().unwrap();
    let mut content = SINGLE_WRITE_ACTIONS.to_string();
    content.push_str(
        r#"
export async function mergeTips(keepId: string, dropId: string) {
  const supabase = await createClient();
  await supabase.from("tips").update({ merged_into: keepId }).eq("id", dropId);
  await supabase.from("tips").delete().eq("id", dropId);
  return { success: true };
}
"#,
    );
    write_file(temp.path(), "lib/actions/tips.ts", &content);

    let report = audit_project(temp.path()).unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.id == "multi-write-no-transaction:lib/actions/tips.ts"),
        "negative control: two writes in one handler keep the finding, got {:?}",
        report.issues.iter().map(|i| &i.id).collect::<Vec<_>>()
    );
}
