(() => {
  const { nodes, paths, connections, groups, sources, ref, gaps } = window.orionArchitecture;
  const $ = id => document.getElementById(id);
  const make = (tag, text = "", className) => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const option = (value, label = value) => new Option(label, value);
  const fmt = new Intl.NumberFormat();
  const byEdge = new Map(connections.map(edge => [edge.id, edge]));
  const pathEdges = new Set(paths.flatMap(path => path.edgeIds));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const quickWidth = new ResizeObserver(() => layoutDiagram());
  const diagram = $("diagrams");
  const viewport = $("walk-viewport");
  const workflow = $("flow-catalog");
  const environment = $("flow-environment");
  const branch = $("flow-branch");
  const panel = $("flow-focus");
  const expanded = $("flow-expanded-view");
  const expand = $("flow-expand");
  const story = $("story-scene");
  const narration = $("walk-narration");
  const speech = window.speechSynthesis;
  const captions = {
    "Orion Web Portal": "Follow recorded listener and host rules to the web server, redirect, or fixed response.",
    "Stax Admin": "Choose a frontend or API path for the selected environment.",
    "Cover Whale outbound reports": "Follow the observed transfer submission and review the separate delivery evidence."
  };
  const colors = {
    Configured: "configured",
    Observed: "observed",
    Verified: "verified",
    "Pending verification": "pending",
    "Access limited": "limited",
    "Zero resources in checked region": "zero",
    "Recorded failure": "failure"
  };
  const serviceTones = {
    EC2: "compute", Lambda: "compute", ECS: "compute", EKS: "compute", WorkSpaces: "compute",
    VPC: "network", "VPC & Networking": "network", CloudFront: "network", "Global Accelerator": "network",
    "Elastic Load Balancing": "network", "API Gateway": "network", RDS: "data", S3: "data", DMS: "data",
    Glue: "data", ECR: "data", IAM: "security", Cognito: "security", KMS: "security", "AWS WAF": "security",
    "Secrets Manager": "security", Inspector: "security", GuardDuty: "security",
    EventBridge: "integration", SNS: "integration", SES: "integration", "Transfer Family": "integration"
  };
  let selected;
  let active = 0;
  let progress = 0;
  let running = false;
  let frame = 0;
  let last = 0;
  let zoom = 1;
  let cards = [];
  let connectors = [];
  let route;
  let sceneDuration = 3400;
  let spokenText = "";
  let localVoice;
  let narrationOn = false;
  let utterance;
  let waitingForVoice = false;
  let speechStarted = false;
  let voiceCompleted = false;
  let voiceElapsed = 0;
  let completing = false;
  let resetTimer = 0;

  function findLocalVoice() {
    const voices = speech?.getVoices() || [];
    localVoice = voices.find(voice => voice.localService && /^en(?:-|$)/i.test(voice.lang));
    narration.hidden = !localVoice || typeof SpeechSynthesisUtterance === "undefined";
  }

  function cancelSpeech() {
    if (!utterance) return;
    utterance = undefined;
    waitingForVoice = false;
    speech.cancel();
    if (speech.paused) speech.resume();
  }

  function narrateStep() {
    if (!narrationOn || !localVoice || speechStarted) return;
    cancelSpeech();
    const message = new SpeechSynthesisUtterance(spokenText);
    message.voice = localVoice;
    message.lang = localVoice.lang;
    message.rate = 0.98;
    const finish = completed => {
      if (utterance !== message) return;
      waitingForVoice = false;
      utterance = undefined;
      voiceCompleted = completed;
      drawControls();
    };
    message.onend = () => finish(true);
    message.onerror = () => finish(false);
    utterance = message;
    waitingForVoice = true;
    speechStarted = true;
    voiceElapsed = 0;
    try {
      speech.speak(message);
    } catch {
      finish(false);
    }
    drawControls();
  }

  function inventoryLink(source) {
    const query = new URLSearchParams({ service: source.service });
    if (source.sheet) query.set("sheet", source.sheet);
    if (source.resource) query.set("resource", source.resource);
    return "inventory.html?" + query;
  }

  function sourceLabel(source) {
    const rows = source.rows;
    const rowLabel = rows.length === 1 ? " · row " + rows[0] :
      rows.length > 1 ? " · rows " + (rows.every((row, index) => row === rows[0] + index) ?
        rows[0] + "–" + rows.at(-1) : rows.join(", ")) : "";
    return [source.workbook || source.service, source.sheet].filter(Boolean).join(" · ") + rowLabel +
      (source.dates.length ? " · " + source.dates.join(", ") : "");
  }

  function sourceLinks(container, refs) {
    for (const source of refs) {
      const item = make("a", sourceLabel(source));
      item.href = inventoryLink(source);
      container.append(item);
    }
  }

  function badge(status) {
    return make("span", status, "status status-" + (colors[status] || "neutral"));
  }

  function nodeLink(node, className, label = node.label) {
    const element = make(node.source ? "a" : "span", label, className);
    if (node.source) element.href = inventoryLink(node.source);
    return element;
  }

  function layoutDiagram() {
    if (!route) return;
    const desktop = viewport.clientWidth >= 690;
    route.classList.toggle("walk-grid", desktop);
    route.style.setProperty("--walk-zoom", zoom);
    const position = index => {
      const row = Math.floor(index / 4);
      const slot = index % 4;
      return { row: row * 2 + 1, col: (row % 2 ? 3 - slot : slot) * 2 + 1 };
    };
    for (const [index, card] of cards.entries()) {
      const dest = position(index);
      card.style.gridArea = dest.row + " / " + dest.col;
      if (!index) continue;
      const start = position(index - 1);
      const connector = connectors[index - 1];
      const direction = start.row !== dest.row ? "down" : dest.col > start.col ? "right" : "left";
      connector.dataset.direction = desktop ? direction : "down";
      connector.style.gridArea = direction === "down" ?
        (dest.row - 1) + " / " + dest.col : dest.row + " / " + ((start.col + dest.col) / 2);
    }
  }

  function drawDiagram() {
    const fragment = document.createDocumentFragment();
    cards = [];
    connectors = [];
    route = make("ol", "", "walk-route");
    route.setAttribute("aria-label", selected.branch + " path");
    for (const [index, id] of selected.nodeIds.entries()) {
      const node = nodes.get(id);
      if (index) {
        const edge = byEdge.get(selected.edgeIds[index - 1]);
        const connector = make("li", "", "walk-edge");
        connector.dataset.edgeId = edge.id;
        const track = make("span", "", "walk-track");
        track.setAttribute("aria-hidden", "true");
        track.append(make("i", "", "walk-pulse"));
        const label = make("button", edge.label, "walk-edge-label");
        label.type = "button";
        label.title = "Show connector evidence";
        label.addEventListener("click", () => jump(index));
        connector.append(label, track);
        fragment.append(connector);
        connectors.push(connector);
      }
      const card = make("li", "", "walk-card");
      card.dataset.nodeId = id;
      const content = nodeLink(node, "walk-node", "");
      const chip = make("span", node.role, "walk-node-role");
      chip.dataset.tone = serviceTones[node.source?.service] || "neutral";
      content.append(chip, make("strong", node.label));
      card.append(content);
      fragment.append(card);
      cards.push(card);
    }
    route.append(fragment);
    diagram.replaceChildren(route);
    layoutDiagram();
  }

  function bringIntoView() {
    const card = cards[active];
    if (!card) return;
    const current = card.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    const top = current.top < bounds.top || current.bottom > bounds.bottom ?
      viewport.scrollTop + current.top - bounds.top - 12 : viewport.scrollTop;
    const left = current.left < bounds.left || current.right > bounds.right ?
      viewport.scrollLeft + current.left - bounds.left - 12 : viewport.scrollLeft;
    if (top !== viewport.scrollTop || left !== viewport.scrollLeft) {
      viewport.scrollTo({ top, left, behavior: reduceMotion.matches ? "instant" : "smooth" });
    }
  }

  function drawPulse() {
    story.style.setProperty("--story-progress", reduceMotion.matches ? 0 : progress);
    story.classList.toggle("is-receiving", !reduceMotion.matches && running && !waitingForVoice && progress >= 0.76);
    for (const [index, connector] of connectors.entries()) {
      connector.classList.toggle("in-motion", index === active && progress > 0 && !reduceMotion.matches);
      connector.style.setProperty("--progress", index === active ? progress : 0);
    }
  }

  function drawControls() {
    $("walk-play").textContent = running ? "Pause" : "Play";
    $("walk-play").title = running ? "Pause playback" : "Play inventory walkthrough";
    $("walk-prev").disabled = active === 0 && progress === 0;
    $("walk-next").disabled = active === cards.length - 1;
    story.classList.toggle("is-playing", running && !waitingForVoice);
    story.classList.toggle("is-narrating", running && waitingForVoice);
  }

  function drawStory(node, ended) {
    const outgoing = byEdge.get(selected.edgeIds[active]);
    const portrait = (id, actor) => {
      const art = make("span", "", "story-art");
      art.dataset.tone = serviceTones[actor.source?.service] || "neutral";
      art.append(make("i"), make("span", "", "story-face"), make("span", "", "story-spark"));
      $(id).replaceChildren(art, make("strong", actor.label));
    };
    story.classList.toggle("is-ended", ended);
    $("story-crossing").hidden = ended;
    $("story-to").hidden = ended;
    portrait("story-from", node);
    if (ended) return;
    portrait("story-to", nodes.get(outgoing.to));
    $("story-cue").textContent = outgoing.label;
    story.dataset.packet = /transfer|parquet|snapshot|data source/i.test(outgoing.type + " " + outgoing.label) ? "file" :
      /alarm|event|monitoring/i.test(outgoing.type) ? "event" : "request";
  }

  function handoff(incoming, node) {
    if (incoming.explanation) return incoming.explanation;
    const source = nodes.get(incoming.from).label;
    const verb = incoming.label.replace(/[.!?]$/, "");
    const stories = {
      "Accepts TCP 443": "The public entry point accepts the request over TCP port 443.",
      "Sends to registered ALB": "The regional endpoint group passes the request to the registered application load balancer.",
      "Reaches HTTPS 443": "The request arrives at the load balancer’s HTTPS listener on port 443.",
      "Matches the host": "The load balancer checks the hostname against its priority 1 rule.",
      "Forwards to target group": "The matching rule sends the request to " + node.label + ".",
      "Reaches EC2 on port 443": "The target group passes the request to the Orion web server on port 443.",
      "Takes the default rule": "The hostname does not match the forwarding rule, so the listener uses the default rule.",
      "Returns HTTP 503": "The listener returns its configured HTTP 503 response.",
      "Enters CloudFront": "The Stax hostname sends the browser request to its CloudFront distribution.",
      "Uses the default S3 origin": "CloudFront retrieves the frontend from the S3 bucket " + node.label + ".",
      "Runs the viewer function": "CloudFront calls its viewer-request function to rewrite the API path.",
      "Reaches the internal ALB": "The VPC link carries the request to the internal application load balancer.",
      "Returns a transfer ID": "The transfer service returns an ID for the submission."
    };
    return stories[verb] || "From " + source + ", the flow moves to " + node.label + ". " + verb + ".";
  }

  function drawStep(scroll = false) {
    const node = nodes.get(selected.nodeIds[active]);
    const incoming = byEdge.get(selected.edgeIds[active - 1]);
    const ended = active === cards.length - 1;
    $("story-reset-note").hidden = true;
    story.classList.remove("is-finished");
    $("walk-counter").textContent = (active + 1) + " / " + cards.length;
    const action = incoming ? handoff(incoming, node) :
      "Start at " + node.label + ".";
    spokenText = action + (ended ? " " + selected.outcome : "");
    speechStarted = false;
    voiceCompleted = false;
    sceneDuration = Math.min(7900, Math.max(3000, 1150 + spokenText.split(/\s+/).length * 240));
    $("walk-step").textContent = "Step " + (active + 1) + " of " + cards.length + " — " + spokenText;
    drawStory(node, ended);
    const evidence = $("walk-evidence");
    evidence.replaceChildren();
    if (incoming) evidence.append(badge(incoming.status));
    if (node.detail) evidence.append(make("span", node.detail, "walk-identifiers"));
    sourceLinks(evidence, incoming?.refs || (node.source ? [node.source] : []));
    cards.forEach((card, index) => {
      card.classList.toggle("is-current", index === active);
      card.classList.toggle("is-complete", index < active);
      if (index === active) card.setAttribute("aria-current", "step");
      else card.removeAttribute("aria-current");
    });
    connectors.forEach((edge, index) => edge.classList.toggle("is-complete", index < active));
    drawPulse();
    drawControls();
    if (scroll) bringIntoView();
  }

  function stop(clear = false) {
    cancelAnimationFrame(frame);
    running = false;
    last = 0;
    if (clear) {
      clearTimeout(resetTimer);
      resetTimer = 0;
      progress = 0;
      completing = false;
      cancelSpeech();
    }
  }

  function finishPlayback() {
    stop(true);
    story.classList.add("is-finished");
    $("story-reset-note").hidden = false;
    drawPulse();
    drawControls();
    resetTimer = setTimeout(() => jump(0), 2200);
  }

  function tick(now) {
    const delta = last ? Math.min(100, now - last) : 0;
    last = now;
    if (waitingForVoice) {
      voiceElapsed += delta;
      // Recover if an installed voice never reports either completion or an error.
      if (voiceElapsed < Math.max(24000, spokenText.length * 160)) {
        frame = requestAnimationFrame(tick);
        return;
      }
      cancelSpeech();
      drawControls();
    }
    if (completing) {
      finishPlayback();
      return;
    }
    progress = Math.min(1, progress + delta / (voiceCompleted ? 1350 : sceneDuration));
    if (progress === 1) {
      progress = 0;
      active++;
      completing = active === cards.length - 1;
      drawStep(true);
      narrateStep();
      if (completing && !waitingForVoice) {
        finishPlayback();
        return;
      }
    } else {
      drawPulse();
    }
    if (running) frame = requestAnimationFrame(tick);
  }

  function play() {
    if (cards.length < 2) return;
    if (active === cards.length - 1 && !completing) jump(0);
    running = true;
    last = 0;
    if (utterance && speech.paused) speech.resume();
    else narrateStep();
    drawControls();
    const bounds = viewport.getBoundingClientRect();
    if (bounds.top + 90 > innerHeight || bounds.bottom < 0) {
      $("flow-title").closest(".walk-head").scrollIntoView({
        block: "start", behavior: reduceMotion.matches ? "instant" : "smooth"
      });
    }
    bringIntoView();
    frame = requestAnimationFrame(tick);
  }

  function jump(index, scroll = true) {
    stop(true);
    active = Math.max(0, Math.min(index, cards.length - 1));
    drawStep(scroll);
  }

  function relatedConnections() {
    const items = connections.filter(edge => edge.workflow === selected.workflow &&
      (!edge.environment || edge.environment === selected.environment) && !pathEdges.has(edge.id) &&
      (selected.workflow !== "Network and infrastructure" || edge.status === "Pending verification" ||
        selected.nodeIds.includes(edge.from) || selected.nodeIds.includes(edge.to)));
    const list = $("walk-related");
    list.replaceChildren();
    for (const edge of items) {
      const item = make("li", "", edge.status === "Pending verification" ? "unconfirmed" : "");
      const line = make("div", "", "related-line");
      line.append(nodeLink(nodes.get(edge.from)), make("span", edge.label, "related-edge"),
        nodeLink(nodes.get(edge.to)), badge(edge.status));
      item.append(line);
      if (edge.explanation) item.append(make("p", edge.explanation));
      const evidence = make("div", "", "walk-evidence");
      sourceLinks(evidence, edge.refs);
      item.append(evidence);
      list.append(item);
    }
    $("walk-overlays").hidden = !items.length;
    $("walk-overlays").open = false;
    $("walk-drilldown").hidden = !selected.drilldown?.length;
    $("walk-records").replaceChildren();
    if (selected.drilldown?.length) {
      $("walk-drilldown-title").textContent = selected.drilldown.length + " " + selected.drilldownLabel;
      selected.drilldown.forEach(source => {
        const item = make("li");
        sourceLinks(item, [source]);
        $("walk-records").append(item);
      });
    }
  }

  function selectPath() {
    stop(true);
    active = 0;
    selected = paths.find(path => path.id === branch.value);
    $("flow-title").textContent = selected.workflow + " · " + selected.branch;
    $("flow-caption").textContent = [selected.environment, selected.region, captions[selected.workflow]].filter(Boolean).join(" · ");
    viewport.scrollTo({ top: 0, left: 0, behavior: "instant" });
    drawDiagram();
    relatedConnections();
    drawStep();
  }

  function selectEnvironment(preferred) {
    const candidates = paths.filter(path => path.workflow === workflow.value && path.environment === environment.value);
    branch.replaceChildren(...candidates.map(path => option(path.id, path.branch)));
    if (candidates.some(path => path.id === preferred)) branch.value = preferred;
    selectPath();
  }

  function selectWorkflow(preferred) {
    const values = [...new Set(paths.filter(path => path.workflow === workflow.value).map(path => path.environment))];
    environment.replaceChildren(...values.map(value => option(value)));
    const target = paths.find(path => path.id === preferred);
    if (target && values.includes(target.environment)) environment.value = target.environment;
    selectEnvironment(preferred);
  }

  for (const group of groups) {
    const workflows = [...new Set(paths.filter(path => path.group === group).map(path => path.workflow))];
    if (!workflows.length) continue;
    const options = make("optgroup");
    options.label = group;
    options.append(...workflows.map(value => option(value)));
    workflow.append(options);
  }
  const params = new URLSearchParams(location.search);
  const legacy = { 0: "stax-prod-frontend", 1: "stax-dev-frontend", 2: "portal-match", 3: "stax-signin-prod-create",
    4: "api-meeting", 5: "dms-snapshot", 6: "cover-whale", 11: "poc-email" };
  const initial = paths.find(path => path.id === (params.get("path") || legacy[params.get("flow")])) || paths[0];
  workflow.value = initial.workflow;
  workflow.addEventListener("change", () => selectWorkflow());
  environment.addEventListener("change", () => selectEnvironment());
  branch.addEventListener("change", selectPath);
  $("walk-play").addEventListener("click", () => {
    if (running) {
      stop();
      if (waitingForVoice) speech.pause();
      drawControls();
    } else play();
  });
  narration.addEventListener("click", () => {
    narrationOn = !narrationOn;
    narration.setAttribute("aria-pressed", String(narrationOn));
    narration.textContent = narrationOn ? "Narration on" : "Narration";
    if (!narrationOn) {
      cancelSpeech();
      speechStarted = voiceCompleted;
      drawControls();
    }
    else if (running) narrateStep();
  });
  speech?.addEventListener("voiceschanged", findLocalVoice);
  findLocalVoice();
  window.addEventListener("pagehide", () => {
    if (resetTimer) {
      jump(0, false);
    } else {
      stop(true);
      drawPulse();
      drawControls();
    }
  });
  $("walk-prev").addEventListener("click", () => jump(active - 1));
  $("walk-next").addEventListener("click", () => jump(active + 1));
  $("walk-replay").addEventListener("click", () => { jump(0); play(); });
  $("walk-fit").addEventListener("click", () => {
    zoom = 1;
    layoutDiagram();
    viewport.scrollTo({ left: 0, top: 0, behavior: "instant" });
    bringIntoView();
  });
  for (const [id, change] of [["walk-in", 0.15], ["walk-out", -0.15]]) {
    $(id).addEventListener("click", () => {
      zoom = Math.max(0.75, Math.min(1.65, zoom + change));
      layoutDiagram();
      bringIntoView();
    });
  }
  expand.addEventListener("click", () => {
    if (expanded.open) return expanded.close();
    expanded.append(panel);
    expand.setAttribute("aria-label", "Exit full-screen diagram");
    expand.title = "Exit full-screen diagram";
    expanded.showModal();
    expand.focus();
  });
  expanded.addEventListener("close", () => {
    $("walk-overlays").before(panel);
    expand.setAttribute("aria-label", "Open full-screen diagram");
    expand.title = "Open full-screen diagram";
    expand.focus();
  });
  reduceMotion.addEventListener("change", drawPulse);
  quickWidth.observe(viewport);
  selectWorkflow(initial.id);

  const connectivityService = $("connectivity-service");
  const connectivityStatus = $("connectivity-status");
  const search = $("connectivity-search");
  const connectivityRows = $("connectivity-rows");
  const services = Object.keys(sources).sort((a, b) => a.localeCompare(b));
  const rows = [];
  const keys = new Set();
  for (const edge of connections) {
    const key = JSON.stringify([edge.from, edge.to, edge.type, edge.label, edge.environment, edge.status]);
    if (keys.has(key)) continue;
    keys.add(key);
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    rows.push({ ...edge, from, to, services: [...new Set([from.source?.service, to.source?.service, ...edge.refs.map(ref => ref.service)])] });
  }
  for (const service of services) {
    const represented = rows.some(row => row.services.includes(service) && row.status !== "Pending verification");
    if (represented && !["Location Service", "CodeArtifact", "SQS"].includes(service)) continue;
    const status = service === "Location Service" ? "Access limited" :
      ["CodeArtifact", "SQS"].includes(service) ? "Zero resources in checked region" : "Inventory only";
    const source = ref(service, service === "Location Service" ? "Resource Discovery" :
      service === "CodeArtifact" ? "Inventory" : service === "SQS" ? "Checks and Mappings" : "");
    const explanation = { CodeArtifact: "No domains or repositories were listed.",
      SQS: "No queues were listed. The checked SNS subscriptions and Lambda event source mappings showed no SQS links.",
      "Location Service": "List permissions prevented confirming resource counts. Workload use remains unverified." }[service];
    rows.push({ from: { label: service, source }, label: status === "Inventory only" ? "Inventory coverage" : "Scope check",
      type: "Inventory", region: "us-east-1", status, refs: [source], services: [service], explanation });
  }
  connectivityService.append(option("", "All services"), ...services.map(value => option(value)));
  connectivityStatus.append(option("", "All statuses"), ...[...new Set(rows.map(row => row.status))].sort().map(value => option(value)));
  let page = 0;
  const pageSize = 20;

  function drawConnectivity() {
    const keywords = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = rows.filter(row => (!connectivityService.value || row.services.includes(connectivityService.value)) &&
      (!connectivityStatus.value || row.status === connectivityStatus.value) &&
      keywords.every(word => [row.from.label, row.to?.label, row.label, row.type, row.status,
        row.from.detail, row.to?.detail, row.explanation, row.environment, row.region, ...row.services,
        ...row.refs.map(sourceLabel)].join(" ").toLowerCase().includes(word)));
    const start = page * pageSize;
    connectivityRows.replaceChildren();
    for (const row of matches.slice(start, start + pageSize)) {
      const line = make("tr");
      const relationship = make("td", row.label);
      relationship.append(make("small", row.type));
      if (row.explanation) relationship.append(make("small", row.explanation));
      const evidence = make("td", "", "connectivity-sources");
      sourceLinks(evidence, row.refs);
      const startCell = make("td");
      startCell.append(nodeLink(row.from));
      const endCell = make("td");
      endCell.append(row.to ? nodeLink(row.to) : "—");
      const state = make("td");
      state.append(badge(row.status));
      line.append(startCell, relationship, endCell, make("td", [row.environment, row.region].filter(Boolean).join(" · ")),
        state, evidence);
      connectivityRows.append(line);
    }
    if (!matches.length) {
      const cell = make("td", "No connections match these filters.");
      cell.colSpan = 6;
      connectivityRows.append(make("tr"));
      connectivityRows.lastElementChild.append(cell);
    }
    $("connectivity-count").textContent = fmt.format(matches.length) + " entries";
    $("connectivity-range").textContent = matches.length ?
      fmt.format(start + 1) + "–" + fmt.format(Math.min(start + pageSize, matches.length)) + " of " + fmt.format(matches.length) : "0 entries";
    $("connectivity-prev").disabled = page === 0;
    $("connectivity-next").disabled = start + pageSize >= matches.length;
    connectivityRows.closest(".table-wrap").scrollTop = 0;
  }

  for (const filter of [search, connectivityService, connectivityStatus]) {
    filter.addEventListener(filter === search ? "input" : "change", () => { page = 0; drawConnectivity(); });
  }
  for (const [id, direction] of [["connectivity-prev", -1], ["connectivity-next", 1]]) {
    $(id).addEventListener("click", () => {
      page += direction;
      drawConnectivity();
      if ($(id).disabled) $(direction === 1 ? "connectivity-prev" : "connectivity-next").focus();
    });
  }
  drawConnectivity();
  const checklist = $("verification-gaps");
  for (const gap of gaps) {
    const item = make("li");
    item.append(make("strong", gap.label), make("span", gap.workflow), make("p", gap.needed));
    checklist.append(item);
  }
})();
