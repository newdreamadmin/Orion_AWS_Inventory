(() => {
  const { sources, records: curated } = window.orion;
  const workbook = window.orionWorkbookData;
  const rowKey = (service, sheet, row) => JSON.stringify([service, sheet, row]);
  const rawRows = new Map((workbook?.records || []).map(record => [rowKey(record.service, record.sheet, record.row), record]));
  const curatedRows = new Map(curated.map(record => [rowKey(record.service, record.sheet, record.row), record]));
  const sheetRows = new Map();
  for (const record of workbook?.records || curated) {
    const key = rowKey(record.service, record.sheet);
    if (!sheetRows.has(key)) sheetRows.set(key, []);
    sheetRows.get(key).push(record);
  }
  const nodes = new Map();
  const paths = [];
  const connections = [];
  const gaps = [];
  const groups = ["Portal", "Stax", "Data & Integrations", "Operations & Security", "Billing"];
  const range = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const field = (record, label) => record?.fields[label];
  const rowsIn = (service, sheet) => sheetRows.get(rowKey(service, sheet)) || [];
  const pick = (service, sheet, key, value) => rowsIn(service, sheet).find(record => field(record, key) === value);

  function ref(service, sheet, rows = [], date = "") {
    const numbers = Array.isArray(rows) ? rows : [rows];
    const matches = numbers.map(row => {
      const key = rowKey(service, sheet, row);
      return rawRows.get(key) || curatedRows.get(key);
    });
    const dates = new Set(date ? [date] : []);
    for (const record of matches) {
      for (const [label, value] of Object.entries(record?.fields || {})) {
        if (/^(?:collection|review|observation|observed|event|snapshot|evidence)(?: date| time| timestamp)(?: \(.+\))?$/i.test(label) &&
            /^\d{4}-\d{2}-\d{2}/.test(value)) dates.add(value.slice(0, 10));
      }
    }
    const key = rowKey(service, sheet, numbers[0]);
    const resource = curatedRows.get(key)?.id || rawRows.get(key)?.id;
    return { service, sheet, workbook: sources[service]?.file, rows: numbers, dates: [...dates], resource };
  }

  const recordRef = (record, service, sheet) => ref(service, sheet, record?.row || []);
  const node = (id, label, role, source, detail = "") => {
    nodes.set(id, { id, label, role, source, detail });
    return id;
  };
  const edge = (label, refs, explanation = "", type = "Routing", status = "Configured") =>
    ({ label, refs: Array.isArray(refs) ? refs : [refs], explanation, type, status });

  function connect(from, to, relationship, scope) {
    const id = "edge-" + (connections.length + 1);
    connections.push({ id, from, to, ...relationship, ...scope });
    return id;
  }

  function path(id, group, workflow, environment, branch, outcome, nodeIds, transitions, options = {}) {
    if (nodeIds.length !== transitions.length + 1 || transitions.some(edge => edge.status === "Pending verification")) {
      throw new Error("Invalid playback path " + id);
    }
    const scope = { group, workflow, environment, region: options.region || "us-east-1" };
    const edgeIds = transitions.map((transition, index) => connect(nodeIds[index], nodeIds[index + 1], transition, scope));
    paths.push({ id, ...scope, branch, outcome, nodeIds, edgeIds, ...options });
  }

  function related(workflow, environment, from, to, label, type, status, refs, explanation = "", region = "us-east-1") {
    return connect(from, to, edge(label, refs, explanation, type, status), { workflow, environment, region });
  }

  function pending(workflow, environment, from, to, label, refs, needed) {
    related(workflow, environment, from, to, label, "Unverified relationship", "Pending verification", refs, needed);
    gaps.push({ workflow, label, needed });
  }

  const ELB = "Elastic Load Balancing";
  const GA = "Global Accelerator";
  const portal = "Orion Web Portal";
  const elbFlow = row => ref(ELB, "Traffic Flow", row);
  const ga = row => ref(GA, "Resource Mappings", row);
  const ec2 = id => recordRef(pick("EC2", "EC2 Instances", "Instance ID", id), "EC2", "EC2 Instances");
  const targetArnAt = row => field(rawRows.get(rowKey(ELB, "Traffic Flow", row)), "Target Group ARN (auto)");
  const target = (group, id, arn) => recordRef(rowsIn(ELB, "Registered Targets").find(record =>
    field(record, "Target ID") === id && (arn ?
      field(record, "Target Group ARN") === arn : field(record, "Target Group Name (auto)") === group)), ELB, "Registered Targets");
  const prodInstance = "i-02715688927ae8899";
  const stagingInstance = "i-03a4bf6f8d1a3f801";
  const prodTarget = target("orion-web-target-group", prodInstance, targetArnAt(8));
  const prodServer = ec2(prodInstance);
  node("portal-ga", "Orion-Web-Global-Accelerator", "Global Accelerator", ga(6));
  node("portal-ga-listener", "TCP 443 listener", "Global Accelerator", ga(6), "5ba09f81");
  node("portal-ga-endpoint", "Regional endpoint group", "Global Accelerator", ga(7), "8e97f7cdd002 · 100% traffic dial");
  node("portal-alb", "orion-web-ALB", "Application Load Balancer", ref(ELB, "Load Balancers", 6));
  node("portal-https", "HTTPS 443 listener", "ALB listener", ga(9));
  node("portal-host-match", "Priority 1 host rule", "ALB routing rule", elbFlow(8), "orionfi.net or www.orionfi.net");
  node("portal-host-default", "Default host rule", "ALB routing rule", elbFlow(9));
  node("portal-target", "orion-web-target-group", "ALB target group", prodTarget);
  node("portal-server", "Orion-Web-Server", "EC2", prodServer, prodInstance + " · HTTPS 443");
  node("portal-503", "HTTP 503", "Configured response", elbFlow(9));
  node("portal-http", "HTTP 80 listener", "ALB listener", elbFlow(7));
  node("portal-redirect", "HTTPS redirect", "Configured response", elbFlow(7));
  node("portal-dns", "Public DNS", "Route 53", ref("VPC & Networking", "DNS Route53"));
  node("portal-db", "orion-db-prod", "RDS Custom", ref("RDS", "RDS Inventory", 2));
  const prodEntry = ["portal-ga", "portal-ga-listener", "portal-ga-endpoint", "portal-alb", "portal-https"];
  const prodRouting = [
    edge("Accepts TCP 443", ga(6)),
    edge("Selects us-east-1", ga(7), "The listener sends traffic to the us-east-1 endpoint group, configured with a 100% traffic dial."),
    edge("Sends to registered ALB", [ga(8), ref(ELB, "Integrations", 8)]),
    edge("Reaches HTTPS 443", ga(9))
  ];
  path("portal-match", "Portal", portal, "Production", "Matched Host",
    "The request reaches Orion-Web-Server on HTTPS port 443.", [...prodEntry, "portal-host-match", "portal-target", "portal-server"], [
      ...prodRouting, edge("Matches the host", [ga(10), elbFlow(8)]),
      edge("Forwards to target group", elbFlow(8)),
      edge("Reaches EC2 on port 443", [ga(11), prodTarget, prodServer])
    ]);
  path("portal-unmatched", "Portal", portal, "Production", "Unmatched Host",
    "The ALB returns the configured HTTP 503. The request stops here.", [...prodEntry, "portal-host-default", "portal-503"], [
      ...prodRouting, edge("Takes the default rule", elbFlow(9)), edge("Returns HTTP 503", [elbFlow(9), ga(10)])
    ]);
  path("portal-redirect", "Portal", portal, "Production", "HTTP 80 Redirect",
    "The ALB redirects the direct HTTP request to HTTPS.", ["portal-alb", "portal-http", "portal-redirect"], [
      edge("Receives direct HTTP", elbFlow(7)), edge("Redirects to HTTPS", elbFlow(7))
    ]);
  pending(portal, "Production", "portal-dns", "portal-ga", "Public DNS resolution", [
    ref("VPC & Networking", "DNS Route53"), ref("API Gateway", "Custom Domain", 2)
  ], "DNS Route53 has no populated rows. The API Gateway custom domain had zero stage mappings, and the inventoried CloudFront distributions serve Stax Admin. Provide public DNS answers or a populated Route 53 export that maps the portal hostname to Global Accelerator.");
  pending(portal, "Production", "portal-server", "portal-db", "Application database calls", [
    prodServer, ref("RDS", "RDS Inventory", 2)
  ], "Provide a redacted Orion-Web-Server connection configuration or an application trace confirming the database endpoint and database used.");

  node("staging-alb", "staging-orion-web-ALB", "Application Load Balancer", ref(ELB, "Load Balancers", 7));
  node("staging-server", "Staging-Orion-Web-Server", "EC2", ec2(stagingInstance), stagingInstance);
  for (const [id, row, listener, group, port, condition] of [
    ["http", 14, "HTTP 80", "staging-orion-web-target-group", 80, "Default rule"],
    ["https", 15, "HTTPS 443", "staging-orion-web-target-group", 80, "Default rule"],
    ["cerebrum", 12, "HTTP 5000", "staging-orion-web-target-group-2", 5000, "Path (value) = cerebrum"],
    ["default", 13, "HTTP 5000", "staging-orion-web-target-group-2", 5000, "Default rule"]
  ]) {
    const targetRef = target(group, stagingInstance, targetArnAt(row));
    node("staging-listener-" + id, listener, "ALB listener", elbFlow(row));
    node("staging-rule-" + id, condition, "ALB routing rule", elbFlow(row));
    node("staging-target-" + id, group, "ALB target group", targetRef);
    path("staging-" + id, "Portal", portal, "Staging", listener + " · " + condition,
      "The staging rule is configured for EC2 port " + port + (port === 5000 ? ". The target was unhealthy in the snapshot." : "."),
      ["staging-alb", "staging-listener-" + id, "staging-rule-" + id, "staging-target-" + id, "staging-server"], [
        edge("Receives " + listener, elbFlow(row)), edge("Evaluates the rule", elbFlow(row)),
        edge("Forwards to target group", elbFlow(row)),
        edge("Routes to EC2 port " + port, [elbFlow(row), targetRef, ec2(stagingInstance)])
      ]);
  }
  pending(portal, "Staging", "portal-dns", "staging-alb", "Staging public entry", ref("VPC & Networking", "DNS Route53"),
    "Provide the staging hostname, public DNS record, and evidence of the mapped staging ALB entry point.");

  const lookup = (service, sheet, key, value) => recordRef(pick(service, sheet, key, value), service, sheet);
  const lambda = name => lookup("Lambda", "Functions", "Function name", name);
  const bucket = name => lookup("S3", "S3 Inventory", "Bucket Name", name);
  const rds = name => lookup("RDS", "RDS Inventory", "DB Identifier", name);
  const sns = name => lookup("SNS", "Topics", "Topic", name);
  const routeRef = row => ref("API Gateway", "Route Integrations", row);
  const stax = "Stax Admin";
  node("stax-vpc", "Shared Orion VPC", "Amazon VPC", lookup("VPC & Networking", "VPC Inventory", "VPC ID", "vpc-094b3d8668a6924ac"), "vpc-094b3d8668a6924ac");
  for (const [suffix, subnet] of [["a", "subnet-0ee8b9d0f3999f4f9"], ["b", "subnet-0265686152c60afe5"]]) {
    node("stax-subnet-" + suffix, "ECS subnet " + suffix.toUpperCase(), "Amazon VPC subnet", lookup("VPC & Networking", "Subnets", "Subnet ID", subnet), subnet);
  }
  for (const config of [
    { key: "prod", env: "Production", host: "admin.orionfi.net", distribution: "E3KK0VMH3FFL4O", originAccess: "E1BCI57NE5860X",
      bucket: "orionfi-stax-prod-frontend", apiId: "irzyz2t88l", link: "hvf95d", revision: "prod-api:29", group: "sg-007f7b9e138a73fab",
      route: 13, cf: 2, ecs: 3, s3: 25, pool: 4, lb: 9 },
    { key: "dev", env: "Development", host: "admin-dev.orionfi.net", distribution: "E3XZH7UKINQN7", originAccess: "EN00Z5PPQQV24",
      bucket: "orionfi-stax-dev-frontend-2", apiId: "tdz31w58v5", link: "x11ij8", revision: "dev-api:965", group: "sg-00cc100cb792a21d7",
      route: 12, cf: 4, ecs: 2, s3: 24, pool: 3, lb: 8 }
  ]) {
    const { key, env } = config;
    const id = part => "stax-" + key + "-" + part;
    const cf = (sheet, row = config.cf) => ref("CloudFront", sheet, row);
    const ecs = sheet => ref("ECS", sheet, config.ecs);
    const route = routeRef(config.route);
    const lbName = key + "-api-int";
    const targetGroup = key + "-api-tg";
    const app = key + "-api";
    const stableMapping = rowsIn("ECS", "Traffic Mapping").find(record =>
      field(record, "API Gateway ID") === config.apiId && field(record, "Stage") === key &&
      field(record, "VPC link") === config.link && field(record, "Internal ALB") === lbName &&
      field(record, "Target group") === targetGroup && field(record, "ECS service") === app);
    const stableMappingRef = recordRef(stableMapping, "ECS", "Traffic Mapping");
    const trafficRows = rowsIn(ELB, "Traffic Flow").filter(record =>
      field(record, "LB Name (auto)") === lbName && field(record, "Target Group (auto)") === targetGroup);
    const traffic = ref(ELB, "Traffic Flow", trafficRows.map(record => record.row));
    const targetArn = field(trafficRows[0], "Target Group ARN (auto)");
    const taskRow = rawRows.get(rowKey("ECS", "Task Definitions", config.ecs));
    const workloadRow = rawRows.get(rowKey("ECR", "Workload Mappings", config.ecs));
    const imageTag = field(taskRow, "Image tag") || "";
    const image = field(workloadRow, "Image URI and tag") || "";
    const auth = "stax-" + key + "-cognito-authorizer";
    const apiName = "stax-" + key + "-api";
    const stageRef = recordRef(rowsIn("API Gateway", "Stages").find(record =>
      field(record, "API") === apiName && field(record, "Stage") === key &&
      field(record, "Invoke URL")?.includes(config.apiId + ".")), "API Gateway", "Stages");
    node(id("viewer"), config.host, "Viewer hostname", cf("Distributions", config.ecs));
    node(id("cdn"), "Stax " + key + " distribution", "CloudFront", lookup("CloudFront", "Distributions", "Distribution ID", config.distribution), config.distribution);
    node(id("bucket"), config.bucket, "S3 frontend", bucket(config.bucket), "Origin access ID " + config.originAccess);
    node(id("rewrite"), config.bucket + "-api-rewrite", "Viewer-request function", cf("Cache Behaviors"), "/api/* → /" + key + "/*");
    node(id("stage"), apiName, "API Gateway stage " + key, stageRef, config.apiId + " · " + key);
    node(id("route"), "ANY /{proxy+}", "API route", route, auth);
    node(id("authorizer"), auth, "API authorizer", route);
    node(id("pool"), "stax-" + key + "-user-pool", "Cognito user pool", ref("Cognito", "User Pools", config.pool));
    node(id("link"), "VPC link", "API Gateway", route, config.link);
    node(id("alb"), lbName, "Internal ALB", ref(ELB, "Load Balancers", config.lb), "HTTP 80");
    node(id("target"), targetGroup, "ALB target group", traffic, targetArn);
    node(id("service"), app, "ECS service", stableMappingRef, key + "-cluster · api:3000");
    node(id("task"), config.revision, "ECS task definition", ecs("Task Definitions"));
    node(id("image"), key + "-stax-health-api", "ECR image", ref("ECR", "Workload Mappings", config.ecs), image);
    node(id("sg"), key + " task security group", "Amazon VPC security group", ecs("Networking"), config.group);
    path(id("frontend"), "Stax", stax, env, "Frontend Assets", "S3 serves the frontend, with index.html as the default root object.",
      [id("viewer"), id("cdn"), id("bucket")], [
        edge("Enters CloudFront", lookup("CloudFront", "Distributions", "Distribution ID", config.distribution)),
        edge("Uses the default S3 origin", [cf("Routing and Edge", config.cf + 1), cf("Origin Mappings", config.cf + 1)])
      ]);
    path(id("api"), "Stax", stax, env, "API Request",
      "The request reaches " + app + " through the stable target-group mapping, on api:3000.",
      [id("viewer"), id("cdn"), id("rewrite"), id("stage"), id("route"), id("link"), id("alb"), id("target"), id("service")], [
        edge("Enters CloudFront", lookup("CloudFront", "Distributions", "Distribution ID", config.distribution)),
        edge("Runs the viewer function", cf("Cache Behaviors")),
        edge("Rewrites to /" + key + "/*", [cf("Routing and Edge"), cf("Origin Mappings"), stageRef]),
        edge("Matches the proxy route", route, "API Gateway matches ANY /{proxy+}. The route lists " + auth + "."),
        edge("Uses the VPC link", route, "API Gateway forwards through VPC link " + config.link + "."),
        edge("Reaches the internal ALB", route),
        edge("Routes to target group", traffic),
        edge("Reaches matching ECS service", [traffic, stableMappingRef, ecs("Networking")],
          "The ELB target group maps to " + app + ". Task identities are joined through that stable mapping rather than snapshot IP addresses.")
      ]);
    related(stax, env, id("bucket"), id("cdn"), "Allows matching distribution s3:GetObject", "Permission", "Configured",
      ref("S3", "S3 Dependencies", config.s3));
    related(stax, env, id("route"), id("authorizer"), "Lists route authorizer", "Authentication configuration", "Configured", route);
    pending(stax, env, id("authorizer"), id("pool"), env + " authorizer-to-pool join", [route, ref("Cognito", "User Pools", config.pool)],
      "Export the API Gateway authorizer's provider ARN and match its exact user pool ID.");
    related(stax, env, id("service"), id("task"), "Runs recorded task revision", "Deployment dependency", "Configured", ecs("Task Definitions"));
    if (image && imageTag && image.endsWith(":" + imageTag)) {
      related(stax, env, id("task"), id("image"), "References image tag " + imageTag, "Deployment dependency", "Configured",
        [ecs("Task Definitions"), ref("ECR", "Workload Mappings", config.ecs)]);
    }
    related(stax, env, id("service"), "stax-vpc", "Places tasks in shared VPC", "Network placement", "Configured", ecs("Networking"));
    for (const suffix of ["a", "b"]) {
      related(stax, env, id("service"), "stax-subnet-" + suffix, "Places tasks in private network", "Network placement", "Configured",
        [ecs("Networking"), nodes.get("stax-subnet-" + suffix).source], "Auto-assign public IP is off.");
    }
    related(stax, env, id("service"), id("sg"), "Assigns task security group", "Network placement", "Configured",
      ecs("Networking"), config.group);
  }

  const signin = "Stax sign-in";
  node("challenge-channel", "Challenge delivery channel", "Unverified delivery", ref("Cognito", "Lambda Triggers"));
  for (const [key, environment, poolRow, clientRow, firstTrigger, poolId] of [
    ["prod", "Production", 4, 5, 5, "us-east-1_GQ2XSa1kD"], ["dev", "Development", 3, 4, 2, "us-east-1_BMqZVprg0"]
  ]) {
    const pool = "stax-" + key + "-pool";
    const client = node("signin-" + key + "-client", "stax-" + key + "-client", "Cognito app client", ref("Cognito", "App Clients", clientRow));
    nodes.get(pool).detail = poolId;
    ["create", "define", "verify"].forEach((action, index) => {
      const triggerRef = ref("Cognito", "Lambda Triggers", firstTrigger + index);
      const name = "stax-" + key + "-mfa-" + action + "-auth";
      const destination = node("signin-" + key + "-" + action, name, "Lambda challenge trigger", lambda(name));
      path("stax-signin-" + key + "-" + action, "Stax", signin, environment, action[0].toUpperCase() + action.slice(1) + " challenge",
        "The app client uses custom Lambda challenges. Built-in Cognito MFA was off in this snapshot.",
        [client, pool, destination], [
          edge("Uses the configured pool", [ref("Cognito", "App Clients", clientRow), ref("Cognito", "User Pools", poolRow)]),
          edge("Runs " + action + " challenge", [triggerRef, lambda(name)], "", "Authentication configuration")
        ]);
    });
    pending(signin, environment, pool, "challenge-channel", environment + " challenge delivery",
      ref("Cognito", "Lambda Triggers", range(firstTrigger, firstTrigger + 2)),
      "Provide the deployed challenge Lambda configuration and a redacted invocation or delivery trace showing the channel used.");
  }
  const pocClient = node("poc-client", "orion-authentication-POC", "Cognito app client", ref("Cognito", "App Clients", 2));
  const pocPool = node("poc-pool", "Modernization POC pool", "Cognito user pool", ref("Cognito", "User Pools", 2), "us-east-1_Yyf6KBAYf");
  const pocSender = node("poc-sender", "Verified POC sender", "Amazon SES", ref("SES", "Application Mappings", 2));
  path("poc-email", "Stax", "Modernization POC", "Proof of concept", "Sign-in email",
    "The pool offers password and passkey sign-in with optional built-in MFA. SES was in the sandbox.",
    [pocClient, pocPool, pocSender], [
      edge("Uses password or passkey", [ref("Cognito", "App Clients", 2), ref("Cognito", "Authentication", [3, 4, 5])]),
      edge("Uses configured SES sender", [ref("SES", "Application Mappings", 2), ref("SES", "Verified Identities"), ref("SES", "Sending Limits and Usage")])
    ]);

  const api = "Orion API Gateway";
  const apiStage = (name, stage, id) => recordRef(rowsIn("API Gateway", "Stages").find(record =>
    field(record, "API") === name && field(record, "Stage") === stage &&
    field(record, "Invoke URL")?.includes(id + ".")), "API Gateway", "Stages");
  const orionStage = apiStage("orion-api", "dev", "0kamxw4kmk");
  const meetingStage = apiStage("orion-meeting-api", "api", "lfzw9tqiv3");
  node("orion-api-stage", "orion-api", "API Gateway dev stage", orionStage, "0kamxw4kmk · dev");
  node("meeting-api-stage", "orion-meeting-api", "API Gateway api stage", meetingStage, "lfzw9tqiv3 · api");
  node("orion-api-waf", "Orion-APIGateway-WAF", "AWS WAF", ref("AWS WAF", "Resource Mapping", 6));
  node("meeting-api-waf", "Orion-Meeting-APIGateway-WAF", "AWS WAF", ref("AWS WAF", "Resource Mapping", 7));
  related(api, "Resources configuration", "orion-api-waf", "orion-api-stage", "Protects dev stage", "Protection", "Configured",
    [ref("AWS WAF", "Resource Mapping", 6), orionStage], "The WAF snapshot lists the API and stage by name. The stage ARN is not exposed in that view.");
  related(api, "Resources configuration", "meeting-api-waf", "meeting-api-stage", "Protects api stage", "Protection", "Configured",
    [ref("AWS WAF", "Resource Mapping", 7), meetingStage], "The WAF snapshot lists the API and stage by name. The stage ARN is not exposed in that view.");
  for (const record of rowsIn("API Gateway", "Route Integrations").filter(record => record.row >= 2 && record.row <= 11)) {
    const isMeeting = record.row === 11;
    const id = isMeeting ? "api-meeting" : "api-route-" + record.row;
    const route = routeRef(record.row);
    const label = field(record, "Method") + " " + field(record, "Resource path");
    const name = field(record, "Backend target");
    const routeNode = node(id + "-request", label, "Resources-view route", route,
      isMeeting ? "Orion_Meeting_API_Authorizer · API key required" : "");
    const handler = node(id + "-handler", name, "Lambda integration", lambda(name));
    path(id, "Portal", api, "Resources configuration", (isMeeting ? "Meeting API · " : "Orion API · ") + label,
      "This route points to " + name + " in Resources view. Deployment parity remains pending.",
      [isMeeting ? "meeting-api-stage" : "orion-api-stage", routeNode, handler], [
        edge("Matches the resources route", route), edge("Invokes configured Lambda", [route, lambda(name)])
      ]);
  }
  node("api-deployments", "Active deployments and OPTIONS targets", "API Gateway deployment", ref("API Gateway", "Stages"));
  pending(api, "Resources configuration", "orion-api-stage", "api-deployments", "Resources-to-deployment parity and OPTIONS targets",
    [ref("API Gateway", "Stages"), routeRef(range(14, 24))],
    "Export both active API deployments and exact OPTIONS integrations, then compare them with the recorded Resources routes.");
  node("api-outbound", "External systems and database", "Outbound calls", ref("Lambda", "Service Mappings"));
  pending(api, "Resources configuration", "api-route-7-handler", "api-outbound", "Lambda downstream calls",
    ref("Lambda", "Service Mappings"), "Provide exact function configuration, integration targets, or redacted traces before mapping HubSpot, RDS, PandaDoc, or Stax calls.");

  const snapshots = "RDS to S3 snapshots";
  const taskRef = ref("DMS", "Task Flow", range(6, 19));
  const dep = row => ref("DMS", "Dependencies", row);
  nodes.get("portal-db").source = rds("orion-db-prod");
  node("dms-source", "production-orion-sqlserver-source", "DMS source endpoint", ref("DMS", "Endpoints", 6), "Orion_db1");
  node("dms-instance", "rds-sqlserver-to-s3", "DMS replication instance", ref("DMS", "Instances", 6));
  node("dms-tasks", "Full-load and CDC tasks", "DMS tasks", taskRef);
  node("dms-target", "s3-parquet-target", "DMS target endpoint", ref("DMS", "Endpoints", 7));
  node("lakehouse-bucket", "orionfi-lakehouse-oriondb", "S3 Parquet destination", bucket("orionfi-lakehouse-oriondb"));
  path("dms-snapshot", "Data & Integrations", snapshots, "Production", "SQL Server to Parquet",
    "The populated Task Flow rows use the production SQL Server source and the Parquet S3 target.",
    ["portal-db", "dms-source", "dms-instance", "dms-tasks", "dms-target", "lakehouse-bucket"], [
      edge("Supplies Orion_db1", [dep(6), ref("DMS", "Endpoints", 6)]), edge("Uses replication instance", taskRef),
      edge("Runs recorded tasks", taskRef), edge("Writes to target endpoint", taskRef),
      edge("Stores Parquet in S3", [ref("DMS", "Endpoints", 7), dep(8), bucket("orionfi-lakehouse-oriondb")])
    ], { drilldown: range(6, 19).map(row => ref("DMS", "Task Flow", row)), drilldownLabel: "Task Flow rows" });
  node("dms-staging-db", "staging-orion-db", "RDS SQL Server", rds("staging-orion-db"));
  node("dms-staging-source", "staging-orion-sqlserver-source", "DMS source endpoint", ref("DMS", "Endpoints", 8));
  path("dms-staging", "Data & Integrations", snapshots, "Staging", "Configured source endpoint",
    "The staging source endpoint is configured separately. The populated Task Flow rows use production.",
    ["dms-staging-db", "dms-staging-source"], [edge("Maps to the staging endpoint", [dep(10), ref("DMS", "Endpoints", 8)])]);
  node("dms-access", "DMSS3AccessRole-orionfi-lakehouse-oriondb", "IAM delivery role", dep(9));
  node("dms-kms", "aws/dms", "AWS-managed KMS key", lookup("KMS", "AWS Managed", "Alias", "aws/dms"),
    "799f5df3-4065-429d-89a7-ec5cda521674");
  related(snapshots, "Production", "dms-target", "dms-access", "Uses S3 delivery role", "Permission", "Configured", dep(9));
  related(snapshots, "Production", "dms-source", "dms-kms", "Uses recorded encryption key", "Encryption dependency", "Configured", dep(7));
  related(snapshots, "Production", "dms-instance", "dms-kms", "Uses replication encryption key", "Encryption dependency", "Configured", dep(12));
  related(snapshots, "Staging", "dms-staging-source", "dms-kms", "Uses recorded encryption key", "Encryption dependency", "Configured", dep(11));
  node("lakehouse-runtime", "Databricks runtime ingestion", "Lakehouse consumer", ref("CloudFormation", "Resource Mappings"));
  pending(snapshots, "Production", "lakehouse-bucket", "lakehouse-runtime", "DMS bucket to lakehouse runtime",
    [dep(8), ref("CloudFormation", "Resource Mappings")], "Provide an exact Databricks job, external location, or runtime log that references the DMS bucket and object prefix.");
  node("rds-host-candidate", "Orion-RDS-Server", "Candidate EC2 host", ref("RDS", "RDS-EC2 Mapping"));
  pending(snapshots, "Production", "portal-db", "rds-host-candidate", "RDS Custom backing EC2 host",
    ref("RDS", "RDS-EC2 Mapping"), "Provide the RDS Custom DB-to-EC2 association with matching DB resource ID and EC2 instance ID.");

  const coverWhale = "Cover Whale outbound reports";
  const transfer = row => ref("Transfer Family", "Transfer Flow", row);
  const observed = ref("Transfer Family", "Observed Start Events", 2, "2026-11-23");
  node("cw-lambda", "cw-push-daily-reports", "Lambda", lambda("cw-push-daily-reports"));
  node("cw-start", "StartFileTransfer", "Transfer Family API", transfer(4));
  node("cw-connector", "Cover Whale connector", "Transfer Family", ref("Transfer Family", "Connector"), "c-e58c96b44eed412d8");
  node("cw-remote", "sftp.coverwhale.com/daily_reports", "Configured SFTP destination", transfer(7));
  node("cw-submitted", "Transfer request submitted", "CloudTrail response", observed);
  node("cw-bucket", "cw-daily-reports", "S3 source bucket", bucket("cw-daily-reports"));
  node("cw-role", "cw-transfer-connector-role", "IAM access role", transfer(6));
  const transferSecret = lookup("Secrets Manager", "Secrets", "Secret name", "CW-sftp-transfer-key");
  node("cw-secret", "CW-sftp-transfer-key", "Secrets Manager reference",
    transferSecret.resource ? transferSecret : ref("Transfer Family", "Connector"));
  node("cw-invoker", "Upstream invoker", "Lambda runtime", transfer(9));
  node("cw-delivery", "Per-file delivery", "SFTP outcome", transfer(10));
  path("cover-whale", "Data & Integrations", coverWhale, "Production", "Observed submission",
    "Transfer request submitted. A transfer ID was returned for seven CSVs on 23 November 2026. File delivery remains unverified.",
    ["cw-lambda", "cw-start", "cw-connector", "cw-remote", "cw-submitted"], [
      edge("Calls StartFileTransfer", [transfer(2), transfer(4), observed], "", "Transfer submission", "Observed"),
      edge("Names the connector", [transfer(4), observed], "", "Transfer submission", "Observed"),
      edge("Names the remote directory", [transfer(7), observed], "", "Transfer submission", "Observed"),
      edge("Returns a transfer ID", [transfer(8), observed, ref("Transfer Family", "Sample Transfer Files")], "", "Transfer response", "Observed")
    ]);
  related(coverWhale, "Production", "cw-connector", "cw-bucket", "Reads source CSV files", "Data source", "Observed", [transfer(5), observed]);
  related(coverWhale, "Production", "cw-connector", "cw-role", "Uses S3 access role", "Permission", "Configured", transfer(6));
  related(coverWhale, "Production", "cw-connector", "cw-secret", "References SFTP authentication secret", "Permission", "Configured",
    [ref("Transfer Family", "Connector"), transferSecret]);
  pending(coverWhale, "Production", "cw-invoker", "cw-lambda", "Upstream report trigger", transfer(9),
    "Provide the scheduled rule, event source mapping, or redacted Lambda invocation record identifying the invoker.");
  pending(coverWhale, "Production", "cw-submitted", "cw-delivery", "Cover Whale individual file delivery", [transfer(10), observed],
    "Provide Transfer Family per-file transfer results or SFTP receiver logs correlated to the transfer ID.");

  const operations = "Operations & Security";
  const alerts = "Alerts and automation";
  const eventRule = name => lookup("EventBridge", "Rules and Targets", "Rule", name);
  const topicNode = name => {
    const id = "sns-" + name;
    if (nodes.has(id)) return id;
    return node(id, name, "SNS Standard topic", sns(name));
  };
  const dmsEvents = eventRule("dms-fullload-task-state-change");
  node("dms-event", "DMS task failure or suspension", "DMS event", ref("DMS", "Tasks"));
  node("dms-event-rule", "dms-fullload-task-state-change", "Default EventBridge bus", dmsEvents);
  path("dms-event-alert", operations, alerts, "Production", "DMS failure or suspension",
    "The configured rule publishes the matched event to dms-replication-alerts.",
    ["dms-event", "dms-event-rule", topicNode("dms-replication-alerts")], [
      edge("Matches task failure or suspension", dmsEvents, "", "Event rule"),
      edge("Publishes to SNS", [dmsEvents, sns("dms-replication-alerts")], "", "Event action")
    ]);

  const alarmInventory = name => lookup("CloudWatch", "Alarm Inventory", "Alarm Name", name);
  const relevantAlarm = /^(?:dms-rds-prod-transaction-log-(?:warning|critical|emergency)|dms-task-cdc-lag-|OrionRDSProductionTransactionLogAlarm$|(?:Orion-|custom-orion-db-prod).*(?:InstanceHealth|CPUUtilization-Anomaly)-Alarm$|orion-db-schema-snapshot-errors$|s3orion_anamoly_storage_alarm$)/i;
  for (const record of rowsIn("CloudWatch", "Alarm Actions").filter(record => relevantAlarm.test(field(record, "Alarm Name") || ""))) {
    const name = field(record, "Alarm Name");
    const targetName = field(record, "Target Name");
    const trigger = field(record, "Trigger State");
    const action = ref("CloudWatch", "Alarm Actions", record.row);
    const isLambda = field(record, "Action Type") === "Lambda invocation";
    const alarm = node("alarm-" + name, name, "CloudWatch alarm", alarmInventory(name));
    const target = isLambda ? node("action-" + targetName, targetName, "Lambda action", lambda(targetName)) :
      topicNode(targetName);
    const evidence = [action, ref("CloudWatch", "Action Targets")];
    if (name === "orion-db-schema-snapshot-errors") {
      pending(alerts, "Production", alarm, target, "Schema snapshot SNS action activation", evidence,
        "The source marks this configuration unverified. Provide the active alarm action export and alarm history.");
      const fn = node("schema-function", "orion-db-schema-snapshot", "Lambda", lambda("orion-db-schema-snapshot"));
      const dimensions = lookup("CloudWatch", "Alarm Dimensions", "Alarm Name", name);
      path("schema-metric", operations, alerts, "Production", "Schema snapshot Errors metric",
        "The Errors metric is associated with the CloudWatch alarm. The SNS action remains pending.", [fn, alarm], [
          edge("Monitors Lambda Errors", [dimensions, alarmInventory(name)], "", "Monitoring")
        ]);
      continue;
    }
    const label = trigger + (isLambda ? " invokes " : " publishes to ") + targetName;
    path("alarm-action-" + record.row, operations, alerts, "Production", name + " · " + trigger + (isLambda ? " → Lambda" : " → SNS"),
      isLambda ? "CloudWatch is configured to invoke " + targetName + ". DMS stoppage has not been verified." :
        "The " + trigger + " action is configured to publish to " + targetName + ".",
      [alarm, target], [edge(label, evidence, "", "Alarm action")]);
    if (isLambda) {
      if (!nodes.has("dms-stoppage")) node("dms-stoppage", "DMS task stoppage", "Runtime outcome", ref("DMS", "Tasks"));
      pending(alerts, "Production", target, "dms-stoppage", targetName + " stoppage outcome", [action, ref("DMS", "Tasks")],
        "Correlate CloudWatch alarm history and Lambda invocation logs with DMS StopReplicationTask events and resulting task states.");
    }
  }
  const startupRule = eventRule("minimal-server-startup");
  node("minimal-server", "MinimalTestServer", "EC2 running-state event",
    lookup("EC2", "EC2 Instances", "Instance Name", "MinimalTestServer"));
  node("minimal-rule", "minimal-server-startup", "Default EventBridge bus", startupRule);
  node("minimal-monitor", "minimal-server-monitor", "Lambda", lambda("minimal-server-monitor"));
  path("minimal-startup", operations, alerts, "Production", "MinimalTestServer startup",
    "The recorded running-state rule is configured to invoke minimal-server-monitor.",
    ["minimal-server", "minimal-rule", "minimal-monitor"], [
      edge("Matches the running state", startupRule, "", "Event rule"), edge("Invokes Lambda", startupRule, "", "Event action")
    ]);
  const topics = rowsIn("SNS", "Topics");
  const confirmedTotal = topics.reduce((total, row) => total + (Number(field(row, "Subscriptions")) || 0), 0);
  const subscriberSummary = node("sns-aggregate", confirmedTotal + " confirmed email subscriptions", topics.length + " Standard SNS topics",
    ref("SNS", "Subscriptions"));
  topics.forEach(row => {
    const name = field(row, "Topic");
    const count = field(row, "Subscriptions");
    related(alerts, "Production", topicNode(name), subscriberSummary, count + " confirmed email subscription" + (count === "1" ? "" : "s"),
      "Subscription count", "Verified", [ref("SNS", "Topics", row.row), ref("SNS", "Subscriptions")]);
  });
  const unknownPublisher = node("cw-unknown-publisher", "Unverified publisher", "SNS subscription coverage", ref("SNS", "Publisher Mappings"));
  pending(alerts, "Production", unknownPublisher, topicNode("cw-sftp-transfer-alerts"), "Cover Whale SNS publisher",
    [sns("cw-sftp-transfer-alerts"), ref("SNS", "Publisher Mappings")],
    "Provide exact SNS Publish events or a Lambda, EventBridge, or Transfer Family configuration referencing this topic ARN.");

  const logging = "CloudTrail log delivery";
  const trailRecord = row => ref("CloudTrail", "Service Mapping", row);
  const cloudTrailNodes = new Map();
  for (const record of rowsIn("CloudTrail", "Service Mapping").filter(row => row.row >= 6 && row.row <= 10)) {
    const name = field(record, "Trail Name");
    const trail = node("trail-" + name, name, "CloudTrail", lookup("CloudTrail", "Trail Inventory", "Trail Name", name));
    const targetId = field(record, "Resource ID or ARN");
    const evidence = trailRecord(record.row);
    const relationship = field(record, "Relationship");
    if (!targetId) continue;
    const destination = record.row < 8 ? node("trail-target-" + record.row, targetId.split(":::").at(-1), "Amazon S3",
      bucket(targetId.split(":::").at(-1))) :
      node("trail-target-" + record.row, targetId.split(/role\/service-role\/|:log-group:|:key\//).at(-1).replace(/:\*$/, ""),
        ["CloudWatch Logs", "IAM delivery role", "KMS encryption key"][record.row - 8], evidence);
    cloudTrailNodes.set(record.row, destination);
    if (record.row <= 8) {
      const branch = (record.row === 7 ? "RDS Custom" : "EC2 Activity") + (record.row === 8 ? " → CloudWatch Logs" : " → S3");
      path("trail-" + record.row, operations, logging, "us-east-1", branch,
        "CloudTrail is configured to deliver logs to the shown destination.", [trail, destination], [
          edge("Delivers trail logs", evidence, relationship, "Logging")
        ]);
    } else {
      related(logging, "us-east-1", trail, destination, relationship, record.row === 9 ? "Permission" : "Encryption dependency",
        "Configured", evidence);
    }
  }
  for (const record of rowsIn("S3", "S3 Dependencies").filter(row => field(row, "Related Resource Name") === "s3orion-trail")) {
    const name = field(record, "Bucket Name");
    const source = ref("S3", "S3 Dependencies", record.row);
    const policyBucket = node("trail-policy-bucket", name, "S3 bucket policy", bucket(name));
    const trailRef = node("s3orion-trail", "s3orion-trail", "Policy principal condition", source);
    related(logging, "us-east-1", policyBucket, trailRef, "Permits CloudTrail action under bucket policy",
      "Permission", "Configured", source, "Bucket-policy evidence describes authorization scope.");
  }

  const cfg = "AWS Config";
  const recorder = node("config-recorder", "Configuration recorder", "AWS Config", ref(cfg, "Config Settings"));
  const configBucket = node("config-bucket", "config-bucket-228674975743", "S3 delivery bucket", bucket("config-bucket-228674975743"));
  const configRole = node("config-role", "AWSServiceRoleForConfig", "IAM service-linked role",
    lookup("IAM", "Roles", "Role Name", "AWSServiceRoleForConfig"));
  path("config-delivery", operations, cfg, "us-east-1", "Configuration history delivery",
    "AWS Config is configured to store configuration history in the S3 bucket.", [recorder, configBucket], [
      edge("Delivers configuration history", [ref(cfg, "Service Mapping", 6), ref(cfg, "Config Settings")], "", "Logging")
    ]);
  related(cfg, "us-east-1", recorder, configRole, "Uses service-linked role", "Permission", "Configured", ref(cfg, "Service Mapping", 7));
  for (const record of rowsIn(cfg, "Service Mapping").filter(row => field(row, "Mapping Type") === "Custom rule")) {
    const name = field(record, "Source Key");
    const arn = field(record, "Related Resource (auto)");
    if (!arn?.includes(":function:")) continue;
    const fn = arn.split(":function:")[1];
    const source = ref(cfg, "Service Mapping", record.row);
    const rule = node("config-rule-" + record.row, name, "AWS Config custom rule", source);
    const handler = node("config-function-" + record.row, fn, "Lambda", lambda(fn), arn);
    path("config-rule-" + record.row, operations, cfg, "us-east-1", name,
      "The custom rule is configured to call the exact Lambda ARN shown in the evidence.", [rule, handler], [
        edge("Evaluates with Lambda", [source, lambda(fn)], "", "Monitoring")
      ]);
  }

  const glue = "Inspector inventory crawler";
  const crawlerRef = row => ref("Glue", "Crawler Mapping", row);
  const inspectorBucket = node("glue-source", "Inspector inventory bucket", "Amazon S3", crawlerRef(3),
    "inspector-inventory-prod-us-east-1-e9ddc5d9789b");
  const crawler = node("glue-crawler", "Inspector inventory crawler", "AWS Glue", crawlerRef(2));
  const catalog = node("glue-catalog", "Configured inventory database", "Glue Data Catalog", crawlerRef(6));
  const crawlerRole = node("glue-role", "Amazon-GlueServiceRoleForSSM", "IAM execution role", crawlerRef(5));
  const failedCrawler = node("glue-failure", "Access denied", "Recorded crawler failure",
    ref("Glue", "Run History Sample"), "20 sampled runs failed");
  path("inspector-crawler", operations, glue, "us-east-1", "Recorded crawler failure",
    "All 20 sampled runs failed. The latest run reports S3 access denied, and no catalog database was visible.",
    [inspectorBucket, crawler, failedCrawler], [
      edge("Configures the S3 source", crawlerRef(3), "", "Data source"),
      edge("Records S3 access denied", [crawlerRef(14), ref("Glue", "Run History Sample")],
        "The last sampled run failed on S3 access. The configured catalog destination was not reached.", "Monitoring", "Recorded failure")
    ]);
  related(glue, "us-east-1", crawler, catalog, "Configures catalog destination", "Configuration", "Configured", crawlerRef(6));
  related(glue, "us-east-1", crawler, crawlerRole, "Uses execution role", "Permission", "Configured", crawlerRef(5));
  pending(glue, "us-east-1", crawler, catalog, "Successful crawler output", [crawlerRef(14), ref("Glue", "Overview")],
    "Provide an authorized successful crawler run plus evidence of the resulting Glue database and tables.");

  const network = "Network and infrastructure";
  const netService = "VPC & Networking";
  function identifiedNode(label, role, source) {
    const id = "resource-" + role + "-" + label;
    if (nodes.has(id)) return id;
    return node(id, label, role, source);
  }
  const networkSheets = {
    VPC: ["VPC Inventory", "VPC ID"], Subnet: ["Subnets", "Subnet ID"],
    ENI: ["Network Interfaces", "ENI ID"], "Network Interface": ["Network Interfaces", "ENI ID"],
    "Route Table": ["Route Tables", "Route Table ID"], "Security Group": ["Security Groups", "Security Group ID"],
    "Network ACL": ["Network ACLs", "Network ACL ID"], "VPC Endpoint": ["VPC Endpoints", "Endpoint ID"]
  };
  const networkNode = (label, role, backup) => {
    const matching = networkSheets[role];
    const location = matching && lookup(netService, ...matching, label);
    return identifiedNode(label, role, location?.resource ? location : backup);
  };
  for (const record of rowsIn(netService, "Resource Relationships")) {
    const fields = record.fields;
    const parent = fields["Parent Resource ID"];
    const child = fields["Child Resource ID"];
    if (!parent || !child || parent === "[Redacted]" || child === "[Redacted]" || !fields.Relationship) continue;
    const source = ref(netService, "Resource Relationships", record.row);
    related(network, "", networkNode(parent, fields["Parent Resource Type"], source),
      networkNode(child, fields["Child Resource Type"], source), fields.Relationship, "Network relationship",
      /^yes$/i.test(fields["Mapping Verified"]) ? "Verified" : "Pending verification", source, "", fields.Region);
  }
  for (const sheet of ["EC2-EBS Mapping", "EC2-IAM Mapping", "EC2-Network Mapping", "EC2-SG Mapping"]) {
    for (const record of rowsIn("EC2", sheet)) {
      const fields = record.fields;
      const instance = fields["Instance ID"];
      if (!/^i-[a-f\d]+$/.test(instance || "")) continue;
      const source = ref("EC2", sheet, record.row);
      const compute = identifiedNode(instance, "EC2 instance", ec2(instance));
      const resources = [
        ["Volume ID", "EBS volume", "Attaches EBS volume", /vol-[a-f\d]+/g, "Attachment"],
        ["VPC ID", "VPC", "Runs in VPC", /vpc-[a-f\d]+/g, "Network placement"],
        ["Subnet ID", "Subnet", "Runs in subnet", /subnet-[a-f\d]+/g, "Network placement"],
        ["Network Interface ID", "ENI", "Uses network interface", /eni-[a-f\d]+/g, "Network placement"],
        ["Security Group ID", "Security Group", "Uses security group", /sg-[a-f\d]+/g, "Network placement"]
      ];
      for (const [label, role, relation, pattern, type] of resources) {
        for (const id of (fields[label] || "").match(pattern) || []) {
          related(network, "", compute, networkNode(id, role, source), relation, type, "Configured", source);
        }
      }
      const profile = fields["Instance Profile"];
      if (profile && !/^(?:none|not |n\/a|[-–]|\[redacted\])/i.test(profile)) {
        const profileSource = lookup("IAM", "Instance Profiles", "Instance Profile Name", profile.split("/").at(-1));
        const identity = identifiedNode(profile.split("/").at(-1), "IAM instance profile", profileSource.resource ? profileSource : source);
        related(network, "", compute, identity, "Uses instance profile", "Permission", "Configured", [source, profileSource]);
      }
    }
  }
  const networkExample = rowsIn(netService, "Resource Relationships").find(record =>
    field(record, "Parent Resource ID") === "vpc-094b3d8668a6924ac" && field(record, "Relationship") === "Contains");
  if (networkExample) {
    const source = ref(netService, "Resource Relationships", networkExample.row);
    const subnet = field(networkExample, "Child Resource ID");
    path("network-placement", operations, network, "us-east-1", "Recorded VPC placement",
      "The worksheet records this VPC-to-subnet placement. Additional routes, endpoints, and attachments are in connectivity.",
      ["stax-vpc", networkNode(subnet, "Subnet", source)], [edge("Contains subnet", source, "", "Network relationship", "Verified")]);
  }

  const workspaces = "WorkSpaces directory";
  const directoryId = "d-9066758dc7";
  const directoryRef = lookup("WorkSpaces", "Directories", "Directory ID", directoryId);
  const directory = node("workspaces-directory", directoryId, "Simple AD directory", directoryRef,
    "SAML 2.0 enabled; IdP details and MFA unverified");
  for (const record of rowsIn("WorkSpaces", "Networking").filter(row => field(row, "Directory ID") === directoryId)) {
    const listed = field(record, "Resource ID");
    const source = ref("WorkSpaces", "Networking", record.row);
    const subnet = field(record, "Subnet ID");
    const vpc = field(record, "VPC ID");
    if (listed && listed.startsWith("ws-")) {
      const client = identifiedNode(listed, "Amazon WorkSpaces", lookup("WorkSpaces", "WorkSpaces", "WorkSpace ID", listed));
      path("workspace-" + listed, operations, workspaces, "us-east-1", listed,
        "The WorkSpace is listed under the registered Simple AD directory and the recorded network placement.",
        [client, directory, networkNode(vpc, "VPC", source), networkNode(subnet, "Subnet", source)], [
          edge("Registers with directory", [source, directoryRef], "", "Directory configuration"),
          edge("Uses the recorded VPC", [source, directoryRef], "", "Network placement"),
          edge("Uses the recorded subnet", source, "", "Network placement")
        ]);
      for (const [label, role] of [["ENI ID", "ENI"], ["Security Group ID", "Security Group"]]) {
        const value = field(record, label);
        for (const id of (value || "").match(/(?:eni|sg)-[a-f\d]+/g) || []) {
          related(workspaces, "us-east-1", client, networkNode(id, role, source), "Uses recorded " + role,
            "Network placement", "Configured", source);
        }
      }
    } else if (listed === directoryId) {
      for (const [label, role] of [["Subnet ID", "Subnet"], ["ENI ID", "ENI"], ["Security Group ID", "Security Group"]]) {
        for (const id of (field(record, label) || "").match(/(?:subnet|eni|sg)-[a-f\d]+/g) || []) {
          related(workspaces, "us-east-1", directory, networkNode(id, role, source), "Uses directory " + role,
            "Network placement", "Configured", source);
        }
      }
    }
  }
  const idp = node("workspaces-idp", "SAML identity provider and MFA", "Authentication", directoryRef);
  pending(workspaces, "us-east-1", directory, idp, "WorkSpaces IdP details and MFA policy", directoryRef,
    "Provide SAML provider metadata and the effective IdP MFA policy for this directory.");

  const cfn = "CloudFormation";
  const ownership = "Stack ownership";
  const stackRows = rowsIn(cfn, "Stack Register");
  const stackName = record => (field(record, "Stack ARN") || "").split(":stack/")[1]?.split("/")[0];
  function stack(name) {
    const record = stackRows.find(row => stackName(row) === name);
    return identifiedNode(name, "CloudFormation stack", recordRef(record, cfn, "Stack Register"));
  }
  const lakehouse = stack("OrionFIDataLakehouse");
  const ecrStack = stack("HERE-OpenSearch-ECRs");
  const minStack = stack("OrionLambdaStack");
  const own = (from, to, source, scope = ownership) => related(scope, "", from, to,
    "Owns recorded resource", "Infrastructure ownership", "Configured", source);
  for (const record of rowsIn(cfn, "Resource Mappings")) {
    const group = field(record, "Group");
    const physical = field(record, "Physical ID");
    const type = field(record, "AWS resource type");
    if (!physical || physical === "[Redacted]") continue;
    const mapping = ref(cfn, "Resource Mappings", record.row);
    const name = physical.split(/:policy\/|:role\//).at(-1);
    if (group === "Lakehouse") {
      const source = type === "AWS::S3::Bucket" ? bucket(physical) : mapping;
      own(lakehouse, identifiedNode(name, type, source.resource ? source : mapping),
        [ref(cfn, "Stack Register", 16), mapping]);
    } else if (group === "OpenSearch ECR") {
      const repository = lookup("ECR", "Repositories", "Repository", physical);
      own(ecrStack, identifiedNode(physical, "ECR repository", repository.resource ? repository : mapping),
        [ref(cfn, "Stack Register", 9), mapping]);
    } else if (group === "Databricks" && /^AWS::(?:S3|IAM|Lambda)::/.test(type || "")) {
      const owner = stackRows.find(row => {
        const stack = stackName(row);
        return stack && field(row, "Group") === "Databricks" && physical.includes(stack + "-");
      });
      const from = owner ? stack(stackName(owner)) :
        identifiedNode("Databricks stack resources", "CloudFormation recorded group", ref(cfn, "Stack Register", [10, 12, 13, 14, 15]));
      own(from, identifiedNode(name, type, mapping), [mapping, recordRef(owner, cfn, "Stack Register")]);
    } else if (group === "EventBridge and Lambda" && /minimal-server|AWS::Lambda::Permission/.test(physical + " " + type)) {
      const target = physical === "minimal-server-startup" ? "minimal-rule" :
        physical === "minimal-server-monitor" ? "minimal-monitor" : identifiedNode(name, type, mapping);
      own(minStack, target, [ref(cfn, "Stack Register", 19), mapping], alerts);
    }
  }
  const eksClusterName = "orion-here-opensearch-cluster";
  const controlPlaneStack = stack("eksctl-" + eksClusterName + "-cluster");
  const clusterRef = lookup("EKS", "Clusters", "Cluster Name", eksClusterName);
  const eksCluster = identifiedNode(eksClusterName, "Amazon EKS cluster", clusterRef);
  const clusterOwnership = [ref(cfn, "Stack Register", 8), ref(cfn, "Key Stack Mappings", 5), clusterRef];
  path("eks-ownership", operations, ownership, "us-east-1", "OpenSearch control plane",
    "This walkthrough shows CloudFormation ownership of the cluster.", [controlPlaneStack, eksCluster], [
      edge("Owns the recorded cluster", clusterOwnership, "", "Infrastructure ownership")
    ]);
  for (const [name, stackRow, groupRow] of [
    ["here-backend-nodes-v3", 4, 7], ["here-backend-nodes", 5, 6], ["orion-here-workers-xlarge", 6, 8], ["orion-here-workers", 7, null]
  ]) {
    const groupSource = groupRow ? ref("EKS", "Node Groups", groupRow) : ref(cfn, "Resource Mappings", 19);
    const group = identifiedNode(name, groupRow ? "EKS managed node group" : "Self-managed node group", groupSource);
    own(stack("eksctl-" + eksClusterName + "-nodegroup-" + name), group,
      [ref(cfn, "Stack Register", stackRow), ref(cfn, "Key Stack Mappings", 6), groupSource]);
    related(ownership, "us-east-1", eksCluster, group, "Contains recorded node group", "Infrastructure ownership", "Configured", groupSource);
  }
  const imageRepo = identifiedNode("OpenSearch ECR repositories", "Amazon ECR", ref(cfn, "Resource Mappings", range(46, 53)));
  pending(ownership, "us-east-1", imageRepo, eksCluster, "Running Kubernetes image consumers",
    [ref(cfn, "Resource Mappings", range(46, 53)), clusterRef],
    "Provide a deployment or pod image export with exact ECR image URI or digest for each currently running workload.");

  const coverage = "Systems Manager and Inspector";
  const inventoryAssociation = node("ssm-inventory-association", "InspectorInventoryCollection-do-not-delete", "SSM State Manager",
    ref("Systems Manager", "State Manager", 10), "AWS-GatherSoftwareInventory · rate(30 minutes) · InstanceIds = *");
  const selector = node("ssm-inventory-selector", "All targeted managed instances", "Inventory collection selector",
    ref("Systems Manager", "State Manager", 10));
  path("ssm-inspector", operations, coverage, "us-east-1", "Inspector inventory schedule",
    "State Manager uses AWS-GatherSoftwareInventory every 30 minutes with InstanceIds = *.",
    [inventoryAssociation, selector], [
      edge("Runs the scheduled inventory document", ref("Systems Manager", "State Manager", 10), "", "Monitoring")
    ]);
  for (const record of rowsIn("Systems Manager", "Managed EC2 Nodes")) {
    const instance = field(record, "EC2 instance ID");
    if (!instance) continue;
    const source = ref("Systems Manager", "Managed EC2 Nodes", record.row);
    const agent = identifiedNode(field(record, "Instance name") || instance, "SSM managed node", source);
    related(coverage, "us-east-1", agent, identifiedNode(instance, "EC2 instance", ec2(instance)),
      "Manages matching EC2 instance ID", "Managed-node coverage", "Verified", [source, ec2(instance)]);
  }
  for (const [sheet, idField, service, nameField] of [
    ["EC2 Coverage", "Instance ID", "EC2", "Instance ID"], ["Lambda Coverage", "Function ARN", "Lambda", "Function Name"],
    ["ECR Repositories", "Repository ARN", "ECR", "Repository Name"]
  ]) {
    for (const record of rowsIn("Inspector", sheet)) {
      const identifier = field(record, idField);
      if (!identifier?.startsWith("arn:") && !/^i-[a-f\d]+$/.test(identifier || "")) continue;
      const source = ref("Inspector", sheet, record.row);
      const label = field(record, nameField) || identifier;
      const scanner = identifiedNode("Inspector " + service + " coverage", "Amazon Inspector", ref("Inspector", sheet));
      const resource = service === "EC2" ? ec2(identifier) : service === "Lambda" ? lambda(label) : source;
      const scanned = identifiedNode(label, service + " resource", resource.resource ? resource : source);
      related(coverage, "us-east-1", scanner, scanned, "Scan coverage · " + field(record, "Scan Status"),
        "Monitoring", "Observed", source, "Recorded resource ID: " + identifier);
    }
  }
  const guard = "GuardDuty protection";
  const guardService = node("guard-detector", "GuardDuty detector", "Account-level protection", ref("GuardDuty", "Protection Plans", 6));
  for (const record of rowsIn("GuardDuty", "Protection Plans")) {
    const feature = field(record, "Protection Feature");
    if (!feature) continue;
    const source = ref("GuardDuty", "Protection Plans", record.row);
    const destination = identifiedNode(field(record, "Related Service") || feature, "Account or service scope", source);
    const status = field(record, "Observed Status");
    if (status === "Enabled") {
      path("guard-" + record.row, operations, guard, "us-east-1", feature,
        "The workbook records this protection feature as enabled at the shown scope.", [guardService, destination], [
          edge(feature, source, "", "Monitoring", "Observed")
        ]);
    } else {
      related(guard, "us-east-1", guardService, destination, feature + " · " + status, "Monitoring coverage", "Inventory only", source);
    }
  }
  const findingRows = rowsIn("GuardDuty", "Findings").map(record => record.row);
  if (findingRows.length) {
    const findings = ref("GuardDuty", "Findings", findingRows);
    const findingScope = node("guard-findings", "GuardDuty findings", "Recorded finding evidence", findings);
    related(guard, "us-east-1", guardService, findingScope, "Records security findings", "Monitoring", "Observed", findings,
      "A finding records a security observation at its own scope.");
  }

  const encryption = "Encryption dependencies";
  const secret = node("mapillary-prod", "prod/Mapillary-Credentials", "Secrets Manager reference",
    lookup("Secrets Manager", "Secrets", "Secret name", "prod/Mapillary-Credentials"));
  const managedKey = node("secrets-managed-key", "aws/secretsmanager", "KMS managed key",
    lookup("KMS", "AWS Managed", "Alias", "aws/secretsmanager"));
  path("secret-encryption", operations, encryption, "Production", "Mapillary secret encryption",
    "The verified production secret lists the AWS-managed Secrets Manager key. The shared view includes references only.",
    [secret, managedKey], [
      edge("Uses the recorded managed key", [nodes.get(secret).source, nodes.get(managedKey).source], "", "Encryption dependency")
    ]);
  const devSecret = node("mapillary-dev", "dev/Mapillary-Credentials", "Secrets Manager reference",
    lookup("Secrets Manager", "Secrets", "Secret name", "dev/Mapillary-Credentials"));
  pending(encryption, "", devSecret, managedKey, "Development secret encryption or alias-only association",
    nodes.get(devSecret).source, "Provide redacted Secrets Manager metadata with the exact KMS key ARN or key ID.");

  const billing = "Cost and data transfer";
  const usage = node("billing-transfer", "Data transfer charges", "Data Transfer billing evidence", ref("Data Transfer", "Cost Detail"));
  const costs = node("billing-cost-explorer", "Service-level costs", "AWS Cost Explorer", ref("Cost Explorer", "Monthly Costs"));
  path("billing-evidence", "Billing", billing, "Billing snapshots", "Compare charge evidence",
    "The workbooks report usage and service costs by billing category. Per-resource attribution is pending.",
    [usage, costs], [edge("Compares related billing categories",
      [ref("Data Transfer", "Cost Detail"), ref("Data Transfer", "Quantity Evidence"), ref("Cost Explorer", "Monthly Costs")],
      "", "Billing", "Observed")], { region: "Reported billing scope" });
  const billingResource = node("billing-attribution", "Individual resource attribution", "Billing detail", ref("Data Transfer", "Collection Coverage"));
  pending(billing, "Billing snapshots", usage, billingResource, "Per-resource data transfer attribution", ref("Data Transfer", "Collection Coverage"),
    "Provide a Cost and Usage Report with resource IDs, or correlated flow and billing evidence at the necessary granularity.");
  const location = node("location-unknown", "Location Service inventory", "Access-limited discovery", ref("Location Service", "Resource Discovery"));
  const workload = node("location-workload", "Application usage", "Unverified workload", ref("Location Service", "Usage Evidence"));
  pending(network, "", location, workload, "Location Service resource counts and workload use",
    [ref("Location Service", "Resource Discovery"), ref("Location Service", "Usage Evidence")],
    "Provide an authorized regional list export and exact application references or service usage logs.");

  window.orionArchitecture = { nodes, paths, connections, gaps, groups, sources, ref };
})();
