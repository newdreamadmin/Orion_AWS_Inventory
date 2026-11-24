import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

// Run with the spreadsheet runtime on the module path. The first argument is the dashboard root.
const [root = process.cwd(), serviceFilter, previewPath] = process.argv.slice(2);
const assets = path.resolve(root, "assets");
const output = path.join(assets, "workbook-downloads");
const readData = async (file, prefix) => {
  const text = (await fs.readFile(path.join(assets, file), "utf8")).trim();
  if (!text.startsWith(prefix) || !text.endsWith(";")) throw new Error("Invalid dashboard data: " + file);
  return JSON.parse(text.slice(prefix.length, -1));
};

const { sources, records: curated } = await readData("data.js", "window.orion = ");
const { tabs, records } = await readData("worksheet-data.js", "window.orionWorkbookData = ");
const keyOf = record => JSON.stringify([record.service, record.sheet]);
const workbookRows = new Map();
for (const record of records) {
  const key = keyOf(record);
  if (!workbookRows.has(key)) workbookRows.set(key, []);
  workbookRows.get(key).push(record);
}
const imported = new Set(workbookRows.keys());
for (const record of curated) {
  const key = keyOf(record);
  if (imported.has(key)) continue;
  if (!workbookRows.has(key)) workbookRows.set(key, []);
  workbookRows.get(key).push(record);
}

function excelColumn(label) {
  return [...label].reduce((index, char) => index * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function columnLabel(index) {
  let label = "";
  for (let number = index + 1; number; number = Math.floor((number - 1) / 26)) {
    label = String.fromCharCode(65 + (number - 1) % 26) + label;
  }
  return label;
}

function excelValue(value, label) {
  if (typeof value !== "string") return value ?? null;
  if (/^=/.test(value)) return "'" + value;
  if (/\b(?:row|count|capacity|port|quantity|duration|size|usd|total|gib)\b|^s\.no\.?$/i.test(label) &&
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value.length <= 15) {
    return Number(value);
  }
  return value;
}

function addWorksheet(workbook, service, tab) {
  const sheet = workbook.worksheets.add(tab.name);
  const records = workbookRows.get(JSON.stringify([service, tab.name])) || [];
  const labels = [...new Set([...(tab.columns || []), ...records.flatMap(record => Object.keys(record.fields))])];
  if (!labels.length) {
    sheet.getRange("A1").values = [[tab.withheld ?
      "Rows withheld from the shared inventory." : "No rows are indexed for this worksheet."]];
    sheet.getRange("A:A").format.columnWidth = 50;
    return;
  }

  const gridOnly = labels.every(label => /^Column [A-Z]+$/.test(label));
  const columns = labels.map((label, index) => ({
    label,
    index: gridOnly ? excelColumn(label.slice(7)) : index
  }));
  const headerRow = gridOnly ? 0 : records.length ? Math.min(...records.map(record => record.row)) - 1 : 1;
  const rowCount = Math.max(1, headerRow, ...records.map(record => record.row));
  const columnCount = Math.max(...columns.map(column => column.index)) + 1;
  const values = Array.from({ length: rowCount }, () => Array(columnCount).fill(null));
  if (headerRow > 0) columns.forEach(({ label, index }) => { values[headerRow - 1][index] = label; });
  for (const record of records) {
    for (const { label, index } of columns) {
      values[record.row - 1][index] = excelValue(record.fields[label], label);
    }
  }
  const lastColumn = columnLabel(columnCount - 1);
  sheet.getRange("A1:" + lastColumn + rowCount).values = values;
  if (headerRow > 0) {
    const header = sheet.getRange("A" + headerRow + ":" + lastColumn + headerRow);
    header.format = { fill: "#1B3852", font: { color: "#FFFFFF", bold: true }, wrapText: true, rowHeight: 29 };
    sheet.freezePanes.freezeRows(headerRow);
  }
  for (const { label, index } of columns) {
    const column = columnLabel(index);
    const width = Math.max(label.length + 3,
      ...records.slice(0, 30).map(record => String(record.fields[label] ?? "").length + 3));
    sheet.getRange(column + ":" + column).format.columnWidth = Math.min(42, Math.max(13, width));
  }
}

const services = serviceFilter ? [serviceFilter] : Object.keys(sources);
await fs.mkdir(output, { recursive: true });
for (const service of services) {
  if (!sources[service] || !tabs[service]?.length) throw new Error("No workbook data for " + service);
  const workbook = Workbook.create();
  for (const tab of tabs[service]) addWorksheet(workbook, service, tab);
  workbook.recalculate();
  if (previewPath && service === "EC2") {
    const preview = await workbook.render({ sheetName: "EC2 Instances", range: "A1:H8", scale: 1.2, format: "png" });
    await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
  }
  const filename = sources[service].file.replace(/\.xlsx$/i, "_Dashboard.xlsx");
  const temporary = path.join(output, "." + filename);
  const excel = await SpreadsheetFile.exportXlsx(workbook);
  try {
    await excel.save(temporary);
    await fs.rename(temporary, path.join(output, filename));
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rm(temporary + ".inspect.ndjson", { force: true });
  }
  console.log(service + " · " + tabs[service].length + " worksheets");
}
