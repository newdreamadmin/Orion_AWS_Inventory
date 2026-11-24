$(function () {
  const { sources, serviceMeta, records: curated, flows } = window.orion;
  const names = Object.keys(sources).sort((a, b) => a.localeCompare(b));
  const preferredOrder = [
    "EC2", "RDS", "S3", "WorkSpaces", "VPC & Networking", "IAM", "DMS", "Elastic Load Balancing",
    "CloudWatch", "AWS Config", "EKS", "GuardDuty", "CloudTrail", "Inspector", "Data Transfer",
    "Global Accelerator", "AWS WAF", "KMS", "Secrets Manager", "Cost Explorer", "API Gateway",
    "EventBridge", "Systems Manager", "ECR", "Transfer Family", "CloudFront", "Cognito",
    "ECS", "Glue", "Lambda", "SNS", "SQS"
  ];
  const preferredNames = new Set(preferredOrder);
  const serviceOrder = [
    ...preferredOrder.filter(service => Object.hasOwn(sources, service)),
    ...names.filter(service => !preferredNames.has(service))
  ];
  const workbookData = window.orionWorkbookData;
  const tabsFor = service => workbookData?.tabs[service] ||
    sources[service].included.map(name => ({ name }));
  const worksheetKey = (service, sheet) => JSON.stringify([service, sheet]);
  const rowKey = ({ service, sheet, row }) => JSON.stringify([service, sheet, row]);
  const curatedById = new Map(curated.map(record => [record.id, record]));
  const curatedByRow = new Map(curated.map(record => [rowKey(record), record]));
  const workbookRows = (workbookData?.records || []).map(record => {
    const existing = curatedByRow.get(rowKey(record));
    return existing ? { ...record, id: existing.id, name: existing.name, status: existing.status } : record;
  });
  const importedTabs = new Set(workbookRows.map(({ service, sheet }) => worksheetKey(service, sheet)));
  const records = [...workbookRows, ...curated.filter(({ service, sheet }) => !importedTabs.has(worksheetKey(service, sheet)))];
  const byId = new Map(curatedById);
  for (const record of records) byId.set(record.id, record);
  const counts = new Map();
  for (const { service } of records) counts.set(service, (counts.get(service) || 0) + 1);

  const params = new URLSearchParams(location.search);
  const fmt = new Intl.NumberFormat();
  const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const icons = {
    overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    inventory: 'M4 5h16v14H4z M4 10h16 M9 10v9 M12 14h5',
    architecture: 'M9 3h6v5H9z M3 16h6v5H3z M15 16h6v5h-6z M12 8v4 M6 16v-4h12v4',
    sources: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
    menu: 'M4 6h16 M4 12h16 M4 18h16',
    close: 'M6 6l12 12 M18 6 6 18',
    compute: 'M5 5h14v14H5z M9 9h6v6H9z M9 2v3 M15 2v3 M9 19v3 M15 19v3 M2 9h3 M2 15h3 M19 9h3 M19 15h3',
    network: 'M3 8h6l-2-2 M21 16h-6l2 2 M7 10l2-2 M17 14l-2 2 M4 16h4 M16 8h4 M12 4v16',
    data: 'M4 6c0-4 16-4 16 0v12c0 4-16 4-16 0z M4 6c0 4 16 4 16 0 M4 12c0 4 16 4 16 0',
    security: 'M12 3 4 6v5c0 4 3 8 8 10 5-2 8-6 8-10V6z M9 12l2 2 4-4',
    integrations: 'M12 8v8 M8 12h8 M3 3h5v5H3z M16 3h5v5h-5z M3 16h5v5H3z M16 16h5v5h-5z',
    operations: 'M3 17h18 M5 13l5-5 4 4 5-7 M16 5h3v3',
    application: 'M3 5h18v14H3z M3 9h18 M7 13h4 M7 16h8',
    warning: 'M12 3 2 20h20z M12 9v4 M12 16v.5',
    external: 'M13 4h7v7 M20 4l-9 9 M10 5H4v15h15v-6'
  };
  const icon = name => $('<span>', { class: "glyph", "aria-hidden": "true" }).html(
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="' + icons[name] + '"/></svg>'
  );
  const link = (label, href, className) => $("<a>", { href, class: className }).text(label);
  const cell = (value, className) => $("<td>", { class: className }).text(value);
  const inventoryUrl = ({ service, sheet, resource } = {}) => {
    const query = new URLSearchParams();
    if (service) query.set("service", service);
    if (sheet) query.set("sheet", sheet);
    if (resource) query.set("resource", resource);
    return "inventory.html" + (query.size ? "?" + query.toString() : "");
  };
  const architectureUrl = flow => "architecture.html?flow=" + flow + "#flow-focus";
  const flowViews = [
    { index: 2, title: "Production web", caption: "Follow a visitor from the public entry point to the Orion web server." },
    { index: 0, title: "Stax Admin", caption: "The page and its API calls take different routes.", paths: [
      ["Page assets", ["Loads static files from"]],
      ["API requests", ["Routes /api requests to", "Passes the request to", "Forwards to the API service"]]
    ] },
    { index: 3, title: "Stax sign-in", caption: "Stax checks the sign-in in Cognito and calls Lambda for the custom challenge.", paths: [
      ["Development", ["Checks the sign-in in", "Runs the sign-in challenge"]],
      ["Production", ["Checks the sign-in in", "Runs the sign-in challenge"]]
    ] },
    { index: 4, title: "Orion APIs", caption: "The application firewall protects requests going to the Orion APIs.", paths: [
      ["Meeting API", ["Filters traffic for", "Runs the meeting lookup"]],
      ["Portal API", ["Filters traffic for", "Runs the contract sync"]]
    ] },
    { index: 5, title: "Database snapshots", caption: "Database Migration Service copies a snapshot of the production database to S3.", paths: [
      ["Snapshot route", ["Supplies data to", "Writes the snapshot to"]]
    ] },
    { index: 6, title: "Report export", caption: "Orion submits the daily report files to Cover Whale. Delivery of individual files is still unconfirmed.", paths: [
      ["Transfer route", ["Selects daily reports from", "Passes the files to", "Submits the transfer"]]
    ] },
    { index: 11, title: "Sign-in email", caption: "The Cognito proof of concept uses Amazon SES to send sign-in email.", paths: [
      ["Email route", ["Sends sign-in email through"]]
    ] }
  ];
  const categoryGroups = {
    compute: ["EC2", "ECS", "EKS", "Lambda", "WorkSpaces"],
    network: ["VPC & Networking", "CloudFront", "Global Accelerator", "Elastic Load Balancing", "API Gateway", "Data Transfer", "Location Service"],
    data: ["S3", "RDS", "DMS", "Glue", "ECR", "CodeArtifact"],
    security: ["AWS WAF", "IAM", "KMS", "Secrets Manager", "Cognito", "GuardDuty", "Inspector", "CloudTrail"],
    integrations: ["EventBridge", "SES", "SNS", "SQS", "Transfer Family"]
  };
  const categories = new Map(Object.entries(categoryGroups).flatMap(([category, services]) =>
    services.map(service => [service, category])
  ));
  const category = service => service ? categories.get(service) || "operations" : "external";
  const accentIcon = (name, style = name) => $("<span>", { class: "accent-icon accent-" + style }).append(icon(name));
  const serviceLink = service => $("<a>", { href: inventoryUrl({ service }), class: "service-link" })
    .append(accentIcon(category(service)), $("<span>").text(service));
  const evidenceTypes = {
    verified: "Verified",
    configured: "Configured",
    observed: "Observed",
    pending: "Pending verification",
    limited: "Access limited",
    zero: "Zero resources in scope",
    failure: "Recorded failure"
  };
  const badge = (type, label = evidenceTypes[type]) => $("<span>", { class: "status status-" + type }).text(label);
  const worksheetStatus = /\b(?:status|state|health|verification|run result)(?:\s*\([^)]*\))*$/i;

  function worksheetBadge(value) {
    const text = String(value).trim();
    if (/\b(?:failure|failed|unhealthy|alarm|degraded|timed out)\b/i.test(text)) return badge("failure", value);
    if (/\b(?:pending|unverified|not verified|unknown|in.progress|partial|not assessed)\b/i.test(text)) return badge("pending", value);
    if (/\b(?:access denied|access limited)\b/i.test(text)) return badge("limited", value);
    if (/^(?:stopped|ec2 instance stopped|disabled|not enabled|not applicable|verified empty|0 of 0 instances in service)$/i.test(text)) return badge("neutral", value);
    if (/^(?:running|active|available|healthy|all healthy|one healthy endpoint|ok|online|in[ -]use|passing|passed|success(?:ful)?|verified(?: in .+)?|confirmed|load completed.*)$/i.test(text)) return badge("verified", value);
    if (/^(?:enabled|associated|registered|deployed; enabled|CREATE_COMPLETE|UPDATE_COMPLETE)$/i.test(text)) return badge("configured", value);
    if (/\b(?:captured|observed|monitoring|logging)\b/i.test(text)) return badge("observed", value);
    return badge("neutral", value);
  }

  function recordEvidence(record) {
    record = curatedById.get(record.id) || record;
    const status = record.status;
    if (record.fields["List action denied"]) return "limited";
    if ((serviceMeta[record.service] || "").startsWith("No ") &&
        /^(?:Domains page displayed no domains|Repositories page displayed no repositories|Queue list was empty for the checked region)$/.test(record.name)) return "zero";
    if (/\bfailed\b/i.test(status)) return "failure";
    if (/^(?:pending(?: verification)?|not verified)$/i.test(status)) return "pending";
    if (/^verified(?: in ECS)?$/i.test(status)) return "verified";
    if (/^(?:enabled|associated|deployed; enabled|CREATE_COMPLETE|UPDATE_COMPLETE)$/i.test(status)) return "configured";
    if (/^(?:captured\b|actively monitoring\b)|\bobserved$/i.test(status)) return "observed";
    return "";
  }

  function serviceCoverage(service) {
    const status = serviceMeta[service];
    if (status === "Access limited") return badge("limited");
    if (status.startsWith("No ")) return badge("zero").attr("title", status);
    if (status === "Usage attribution open") return badge("pending", status);
    return badge("neutral", status);
  }

  $("[data-icon]").each(function () { $(this).prepend(icon(this.dataset.icon)); });

  const mobile = matchMedia("(max-width: 880px)");
  const sidebar = document.querySelector("#sidebar");
  const workspace = document.querySelector(".workspace");
  const openMenu = document.querySelector("#menu-open");
  const closeMenu = document.querySelector("#menu-close");
  const shade = document.querySelector("#menu-shade");
  function setMenu(open, restoreFocus = false) {
    sidebar.inert = mobile.matches && !open;
    sidebar.classList.toggle("open", open);
    workspace.inert = open;
    shade.hidden = !open;
    document.body.classList.toggle("menu-active", open);
    openMenu.setAttribute("aria-expanded", String(open));
    if (open) closeMenu.focus();
    if (!open && restoreFocus && mobile.matches) openMenu.focus();
  }
  openMenu.addEventListener("click", () => setMenu(true));
  closeMenu.addEventListener("click", () => setMenu(false, true));
  shade.addEventListener("click", () => setMenu(false, true));
  mobile.addEventListener("change", () => setMenu(false));
  document.addEventListener("keydown", event => {
    if (!sidebar.classList.contains("open")) return;
    if (event.key === "Escape") setMenu(false, true);
    if (event.key !== "Tab") return;
    const controls = sidebar.querySelectorAll("a, button");
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  setMenu(false);

  if ($("#summary").length) {
    const worksheetCount = names.reduce((total, service) => total + tabsFor(service).length, 0);
    const stats = [
      ["AWS services", names.length, "Browse services", "#service-coverage", "inventory", "network"],
      ["Workbook worksheets", worksheetCount, "View source workbooks", "sources.html", "sources", "data"],
      ["Indexed rows", records.length, "Compare row counts", "#volume-heading", "data", "compute"],
      ["Architecture workflows", new Set(window.orionArchitecture?.paths.map(path => path.workflow)).size || flowViews.length,
        "Explore AWS flows", "architecture.html", "architecture", "security"]
    ];
    for (const [label, count, action, href, symbol, tone] of stats) {
      $("#summary").append($("<a>", { href, class: "stat-card" }).append(
        $("<div>", { class: "stat-top" }).append($("<span>").text(label), accentIcon(symbol, tone)),
        $("<strong>").text(fmt.format(count)), $("<span>", { class: "stat-action" }).text(action)
      ));
    }
    const chartCategories = [
      ["compute", "Compute", "#3f78df"],
      ["network", "Networking & delivery", "#149789"],
      ["data", "Data & storage", "#8a62ce"],
      ["security", "Identity & security", "#525ab4"],
      ["integrations", "Integrations", "#da823e"],
      ["operations", "Operations & management", "#6b829d"]
    ];
    const directory = $("#service-directory");
    const filters = $("#category-filters");
    const renderDirectory = selected => {
      const visible = serviceOrder.filter(service => !selected || category(service) === selected);
      $("#directory-count").text(fmt.format(visible.length) + (visible.length === 1 ? " service" : " services"));
      filters.find("button").each(function () {
        $(this).attr("aria-pressed", String(this.dataset.category === selected));
      });
      directory.empty();
      for (const service of visible) {
        const worksheets = tabsFor(service).length;
        const rows = counts.get(service) || 0;
        const card = $("<a>", { class: "overview-service-card", href: inventoryUrl({ service }) }).append(
          accentIcon(category(service)),
          $("<span>", { class: "overview-service-info" }).append(
            $("<strong>").text(service),
            $("<small>").text(fmt.format(worksheets) + (worksheets === 1 ? " worksheet" : " worksheets") +
              " · " + fmt.format(rows) + (rows === 1 ? " row" : " rows"))
          )
        );
        directory.append($("<li>").append(card));
      }
    };
    for (const [key, label] of [["", "All services"], ...chartCategories]) {
      filters.append($("<button>", { type: "button", "data-category": key }).text(label)
        .on("click", () => renderDirectory(key)));
    }
    renderDirectory("");

    let cumulative = 0;
    const segments = [];
    for (const [key, label, color] of chartCategories) {
      const total = names.filter(service => category(service) === key).length;
      if (!total) continue;
      const start = cumulative;
      cumulative += total;
      segments.push(color + " " + (start / names.length * 100) + "% " +
        (cumulative / names.length * 100) + "%");
      const categoryLink = $("<a>", { href: "#service-coverage" }).append(
        $("<span>", { class: "category-swatch", "aria-hidden": "true" }).css("background-color", color),
        $("<span>").text(label), $("<strong>").text(fmt.format(total))
      ).on("click", event => {
        event.preventDefault();
        renderDirectory(key);
        $("#service-coverage")[0].scrollIntoView();
        $("#service-heading")[0].focus({ preventScroll: true });
      });
      $("#category-legend").append($("<li>").append(categoryLink));
    }
    $("#category-total").text(fmt.format(names.length));
    if (segments.length) $("#category-ring").css("background", "conic-gradient(" + segments.join(", ") + ")");

    const topServices = [...names].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0)).slice(0, 7);
    const maximum = counts.get(topServices[0]) || 1;
    const colors = new Map(chartCategories.map(([key, , color]) => [key, color]));
    for (const service of topServices) {
      const total = counts.get(service) || 0;
      const bar = $("<span>", { class: "volume-bar" }).css({
        width: (total / maximum * 100) + "%",
        backgroundColor: colors.get(category(service))
      });
      const row = $("<a>", { href: inventoryUrl({ service }), class: "volume-row" }).append(
        $("<span>", { class: "volume-name" }).text(service),
        $("<span>", { class: "volume-track", "aria-hidden": "true" }).append(bar),
        $("<strong>", { class: "volume-count" }).text(fmt.format(total))
      );
      $("#service-volume").append($("<li>").append(row));
    }

    for (const service of names) {
      const status = serviceMeta[service];
      if (status === "Access limited" || status.startsWith("No ") || status === "Usage attribution open") {
        const evidence = status === "Access limited" ?
          records.find(record => record.service === service && recordEvidence(record) === "limited") : null;
        const href = inventoryUrl({ service, sheet: evidence?.sheet });
        $("#exceptions").append($("<li>").append(link(service, href), serviceCoverage(service)));
      }
    }
    for (const { index, title } of flowViews) {
      if (flows[index].category !== "Applications") continue;
      $("#featured-flows").append($("<li>").append(
        $("<a>", { href: architectureUrl(index), class: "featured-link" })
          .append(accentIcon("application", "compute"), $("<span>").text(title))
      ));
    }
  }

  if ($("#source-rows").length) {
    $("#source-count").text(fmt.format(names.length) + " workbooks");
    const indexedSheets = new Set(records.map(({ service, sheet }) => worksheetKey(service, sheet)));
    for (const service of serviceOrder) {
      const source = sources[service];
      const sheets = $("<td>", { class: "worksheet-links" });
      const filename = source.file.replace(/\.xlsx$/i, "_Dashboard.xlsx");
      const download = link("Download Excel", "assets/workbook-downloads/" + encodeURIComponent(filename), "button workbook-download")
        .attr({ download: filename, "aria-label": "Download " + service + " Excel workbook" });
      for (const tab of tabsFor(service)) {
        const indexed = indexedSheets.has(worksheetKey(service, tab.name));
        const suffix = tab.withheld ? (indexed ? " · limited extract" : " · rows withheld") :
          indexed ? "" : " · no rows";
        sheets.append(link(tab.name + suffix, inventoryUrl({ service, sheet: tab.name })));
      }
      $("#source-rows").append($("<tr>").append(
        $("<td>").append(serviceLink(service)),
        $("<td>", { class: "workbook-name" }).append($("<span>").text(source.file), download),
        sheets
      ));
    }
  }

  if ($("#inventory-tables").length) {
    const pageSize = 25;
    const dialog = document.querySelector("#resource");
    const service = $("#service");
    const sheet = $("#sheet");
    const query = $("#worksheet-query");
    const tables = $("#inventory-tables");
    let page = 0;
    let worksheet;
    let worksheetRecords = [];
    let originalRecords = [];
    let columns = new Map();
    let sort;
    let returnFocus;

    for (const name of serviceOrder) service.append($("<option>").text(name));

    function refreshSheets() {
      const selectedService = service.val();
      sheet.empty().append($("<option>", { value: "" }).text("Select a worksheet"));
      sheet.prop("disabled", !selectedService);
      if (!selectedService) return;
      const tabs = tabsFor(selectedService);
      for (const tab of tabs) sheet.append($("<option>").text(tab.name));
      if (tabs.length) sheet.val(tabs[0].name);
    }

    function showRecord(record, trigger) {
      returnFocus = trigger || sheet[0];
      const evidence = recordEvidence(record);
      $("#resource-service").empty().append(serviceLink(record.service));
      $("#resource-title").text(record.name);
      const badges = $("#resource-evidence").empty().append(badge(evidence || "neutral", evidenceTypes[evidence] || record.status));
      if (evidence && record.status !== evidenceTypes[evidence]) {
        badges.append($("<span>", { class: "recorded-status" }).text("Workbook status: " + record.status));
      }
      $("#resource-source").text([sources[record.service].file, record.sheet, "Row " + record.row].join(" · "));
      $("#resource-worksheet").attr("href", inventoryUrl(record));
      const meta = $("#resource-meta").empty();
      if (record.region) meta.append($("<dt>").text("Region"), $("<dd>").text(record.region));
      if (record.environment) meta.append($("<dt>").text("Environment"), $("<dd>").text(record.environment));
      for (const [label, value] of Object.entries(record.fields)) {
        if (label === "Region" && value === record.region || label === "Environment" && value === record.environment) continue;
        meta.append($("<dt>").text(label), $("<dd>").text(value));
      }
      dialog.showModal();
    }
    dialog.addEventListener("close", () => returnFocus.focus());

    function worksheetTable(items, sortFocus) {
      const label = worksheet.name;
      const selectedService = service.val();
      const worksheetLinks = new Map(tabsFor(selectedService)
        .filter(tab => tab.name !== label)
        .map(tab => [tab.name.trim().toLowerCase(), inventoryUrl({ service: selectedService, sheet: tab.name })]));
      const panel = $("<div>", {
        class: "table-wrap inventory-scroll", tabindex: 0, role: "region",
        "aria-label": label + " table", "aria-describedby": "table-hint"
      });
      const headers = $("<tr>");
      const colgroup = $("<colgroup>");
      let width = 0;
      let focusButton;
      for (const [field, numeric] of columns) {
        const columnWidth = field === "S.No." ? 5.5 : numeric ? 9 : 13;
        width += columnWidth;
        colgroup.append($("<col>").css("width", columnWidth + "rem"));
        const selected = sort?.field === field;
        const button = $("<button>", { type: "button", class: "sort" }).text(field).on("click", () => {
          sort = { field, direction: selected ? -sort.direction : 1 };
          sortRows();
          draw({ field, left: panel[0].scrollLeft });
        });
        if (selected && sortFocus?.field === field) focusButton = button;
        headers.append($("<th>", {
          scope: "col", class: numeric ? "numeric" : "",
          "aria-sort": selected ? (sort.direction === 1 ? "ascending" : "descending") : null
        }).append(button));
      }
      const entries = [...columns];
      const detailField = entries.find(([field]) => /\bname$/i.test(field)) ||
        entries.find(([field, numeric]) => !numeric && !worksheetStatus.test(field)) || entries[0];
      const body = $("<tbody>");
      let hasWorksheetLinks = false;
      for (const record of items) {
        const trigger = $("<button>", { type: "button", class: "row-button" });
        const row = $("<tr>");
        const references = new Map();
        for (const [field] of entries) {
          const value = record.fields[field];
          const href = typeof value === "string" && worksheetLinks.get(value.trim().toLowerCase());
          if (href) references.set(field, href);
        }
        hasWorksheetLinks ||= references.size > 0;
        const canShowDetails = ([field]) => !references.has(field) && Boolean(record.fields[field]);
        const triggerField = canShowDetails(detailField) ? detailField :
          entries.find(entry => !entry[1] && canShowDetails(entry)) || entries.find(canShowDetails);
        for (const [field, numeric] of columns) {
          const value = record.fields[field];
          const empty = value == null || value === "";
          const href = references.get(field);
          const contents = href ? link(value, href, "worksheet-ref") :
            worksheetStatus.test(field) && !empty ? worksheetBadge(value) :
              $("<span>", { class: "cell-value" }).text(empty ? "—" : value);
          row.append($("<td>", { class: numeric ? "numeric" : "" })
            .append(field === triggerField?.[0] ? trigger.append(contents) : contents));
        }
        if (!triggerField) row.children().last().append(trigger.text("Details"));
        body.append(row.on("click", event => {
          if (event.target.closest("a")) return;
          if (trigger[0].contains(event.target) || !window.getSelection()?.toString()) {
            showRecord(record, trigger[0]);
          }
        }));
      }
      panel[0].style.setProperty("--data-columns-width", width + "rem");
      panel.append($("<table>", { class: "inventory-table", "aria-label": label })
        .append(colgroup, $("<thead>").append(headers), body));
      tables.append(panel);
      if (hasWorksheetLinks && !worksheet.withheld) {
        $("#table-hint").text("Select a worksheet link to open that tab, or select another cell for row details.");
      }
      if (focusButton) {
        panel[0].scrollLeft = sortFocus.left;
        focusButton[0].focus({ preventScroll: true });
      }
    }

    function draw(sortFocus) {
      const total = worksheetRecords.length;
      const pages = Math.ceil(total / pageSize);
      const first = page * pageSize;
      tables.empty();
      $("#worksheet-title").prop("hidden", !worksheet);
      $("#worksheet-search").prop("hidden", !originalRecords.length);
      $("#empty-inventory").prop("hidden", total > 0);
      $("#inventory-pager").prop("hidden", pages <= 1);
      if (worksheet) {
        $("#inventory-heading").text(worksheet.name);
        $("#result").text(fmt.format(total) + (total === 1 ? " row" : " rows"));
        $("#table-hint").text(worksheet.withheld ?
          "Personal or confidential source fields are excluded from this view." :
          "Select a column heading to sort. Select a row for details.");
      }
      if (!total) {
        const title = query.val() ? "No matching rows" : worksheet ? (worksheet.withheld ? "Worksheet rows withheld" : "No workbook rows in this worksheet") :
          service.val() ? "Select a worksheet" : "Select a service to begin";
        const message = query.val() ? "Try a different search in this worksheet." : worksheet ? (worksheet.withheld ? "This tab contains personal or confidential data." :
          "This tab has no rows to display.") : service.val() ?
          "Choose one of the worksheets for " + service.val() + "." : "Its workbook worksheets will appear in the second selector.";
        $("#empty-inventory strong").text(title);
        $("#empty-inventory p").text(message);
        return;
      }
      worksheetTable(worksheetRecords.slice(first, first + pageSize), sortFocus);
      $("#page-range").text(fmt.format(first + 1) + "–" +
        fmt.format(Math.min(first + pageSize, total)) + " of " + fmt.format(total));
      $("#page-indicator").text("Page " + (page + 1) + " of " + pages);
      $("#prev").prop("disabled", page === 0);
      $("#next").prop("disabled", page + 1 >= pages);
    }

    function sortRows() {
      const { field, direction } = sort;
      const numeric = columns.get(field);
      worksheetRecords.sort((a, b) => {
        const left = a.fields[field];
        const right = b.fields[field];
        if (left == null || left === "" || right == null || right === "") {
          return Number(left == null || left === "") - Number(right == null || right === "");
        }
        return direction * (numeric ? Number(left) - Number(right) : compare.compare(left, right));
      });
    }

    function selectWorksheet() {
      const selectedService = service.val();
      const selectedSheet = sheet.val();
      worksheet = selectedService && tabsFor(selectedService).find(tab => tab.name === selectedSheet);
      originalRecords = worksheet ? records.filter(record =>
        record.service === selectedService && record.sheet === selectedSheet
      ) : [];
      worksheetRecords = [...originalRecords];
      query.val("");
      columns = new Map((worksheet?.columns || []).map(label => [label, undefined]));
      for (const record of worksheetRecords) {
        for (const [label, value] of Object.entries(record.fields)) {
          const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value));
          columns.set(label, (columns.get(label) ?? true) && numeric);
        }
      }
      page = 0;
      sort = undefined;
      draw();
    }

    const linkedRecord = byId.get(params.get("resource"));
    const linkedService = linkedRecord?.service || params.get("service");
    const linkedSheet = linkedRecord?.sheet || params.get("sheet");
    if (Object.hasOwn(sources, linkedService)) service.val(linkedService);
    refreshSheets();
    if (service.val() && tabsFor(service.val()).some(tab => tab.name === linkedSheet)) sheet.val(linkedSheet);
    service.on("change", () => {
      refreshSheets();
      selectWorksheet();
    });
    sheet.on("change", selectWorksheet);
    query.on("input", () => {
      const words = query.val().trim().toLowerCase().split(/\s+/).filter(Boolean);
      worksheetRecords = originalRecords.filter(record => {
        const searchable = [record.name, ...Object.values(record.fields)].join(" ").toLowerCase();
        return words.every(word => searchable.includes(word));
      });
      page = 0;
      if (sort) sortRows();
      draw();
    });
    $("#prev, #next").on("click", function () {
      page += this.id === "prev" ? -1 : 1;
      draw();
      if (this.disabled) $("#" + (this.id === "prev" ? "next" : "prev")).trigger("focus");
    });
    selectWorksheet();
    if (linkedRecord) showRecord(linkedRecord);
  }

});
