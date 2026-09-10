use super::*;

#[test]
fn accepts_a_validated_destination_with_a_safe_fallback() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "app/api/continue/route.mjs",
        r#"export function GET(request) {
  const url = new URL(request.url);
  const next = url.searchParams.get('next') || '/dashboard';
  let target = new URL('/dashboard', url.origin);
  if (next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')) {
    const candidate = new URL(next, url.origin);
    if (candidate.origin === url.origin) target = candidate;
  }
  return Response.redirect(target, 302);
}"#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(!report
        .issues
        .iter()
        .any(|issue| issue.check_id == "code_scan.open-redirect"));
}

#[test]
fn reports_open_redirect_when_request_origin_is_only_a_url_base() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "app/api/continue/route.mjs",
        r#"export function GET(request) {
  const url = new URL(request.url);
  const next = url.searchParams.get('next') || '/dashboard';
  return Response.redirect(new URL(next, url.origin), 302);
}"#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.check_id == "code_scan.open-redirect"));
}

#[test]
fn reports_open_redirect_when_only_a_slash_prefix_is_checked() {
    let temp = TempDir::new().unwrap();
    write_file(
        temp.path(),
        "app/api/continue/route.mjs",
        r#"export function GET(request) {
  const url = new URL(request.url);
  const next = url.searchParams.get('next') || '/dashboard';
  if (!next.startsWith('/')) return Response.redirect(new URL('/dashboard', url.origin), 302);
  return Response.redirect(new URL(next, url.origin), 302);
}"#,
    );

    let report = audit_project(temp.path()).unwrap();
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.check_id == "code_scan.open-redirect"));
}

#[test]
fn reports_destinations_not_protected_by_nearby_validation() {
    let cases = [
        ("origin read", "void url.origin; return Response.redirect(new URL(next, url.origin));"),
        ("hostname read", "void url.hostname; return Response.redirect(new URL(next, url.origin));"),
        ("host read", "void url.host; return Response.redirect(new URL(next, url.origin));"),
        ("unused helper", "normalizeReturnTo(next); return Response.redirect(new URL(next, url.origin));"),
        ("unused allowlist", "const allowedOrigins = ['https://app.example']; return Response.redirect(new URL(next, url.origin));"),
        ("comparison without a branch", "const target = new URL(next, url.origin); target.origin === url.origin; return Response.redirect(target);"),
        ("conditionally skipped rejection", "const target = new URL(next, url.origin); if (request.headers.has('validate')) if (target.origin !== url.origin) { throw new Error('invalid'); } return Response.redirect(target);"),
        ("different target", "const approved = new URL('/dashboard', url.origin); if (approved.origin !== url.origin) { throw new Error('invalid'); } return Response.redirect(new URL(next, url.origin));"),
        ("self comparison", "const target = new URL(next, url.origin); if (target.origin === target.origin) return Response.redirect(target); return Response.redirect('/dashboard');"),
        ("normalizer followed by tainted data", "return Response.redirect(normalizeReturnTo(next) + next.slice(0));"),
        ("mutated fallback", "function replaceDestination(target, input) { target.href = input; } let target = new URL('/dashboard', url.origin); replaceDestination(target, next); return Response.redirect(target);"),
        ("mutated expected origin", "function replaceOrigin(value, input) { value.href = input; } replaceOrigin(url, next); const target = new URL(next, url.origin); if (target.origin === url.origin) return Response.redirect(target); return Response.redirect('/dashboard');"),
        ("pathname after normalization", "const target = new URL(next, url.origin); if (target.origin !== url.origin) { throw new Error('invalid'); } return Response.redirect(target.pathname);"),
        ("validation inside an uncalled function", "const target = new URL(next, url.origin); function validate() { if (target.origin !== url.origin) { throw new Error('invalid'); } } return Response.redirect(target);"),
    ];
    let mut missed = Vec::new();
    for (name, body) in cases {
        let temp = TempDir::new().unwrap();
        write_file(
            temp.path(),
            "app/api/continue/route.mjs",
            &format!(
                "export function GET(request) {{\nconst url = new URL(request.url);\nconst next = url.searchParams.get('next');\n{body}\n}}"
            ),
        );
        let report = audit_project(temp.path()).unwrap();
        if !report
            .issues
            .iter()
            .any(|issue| issue.check_id == "code_scan.open-redirect")
        {
            missed.push(name);
        }
    }
    assert!(
        missed.is_empty(),
        "unguarded destinations were missed: {missed:?}"
    );
}
