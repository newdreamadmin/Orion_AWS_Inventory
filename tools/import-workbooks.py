"""Build the dashboard's offline worksheet data from the local .xlsx files."""

import json
import re
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
WORKBOOKS = ASSETS / "Orion_Full_Inventory"
OUTPUT = ASSETS / "worksheet-data.js"
REDACTED = "[Redacted]"

PRIVATE_TABS = {
    "WorkSpaces": {"Users", "Assignments"},
    "Cognito": {"Users", "Group Membership"},
    "IAM": {
        "Users", "User-Group Mapping", "User-Policy Mapping", "Credential Metadata",
        "MFA Devices", "IC Assignments", "IC Users", "IC User Attributes",
        "IC Group Memberships", "IC MFA Devices",
    },
    "SNS": {"Subscriptions"},
    "SES": {"Verified Identities"},
}

# These tabs contain separate sections or prose, so retain their worksheet grid.
GRID_TABS = {"start here", "readme", "read me", "how to fill", "network dashboard", "dashboard"}
PRIVATE_COLUMN = re.compile(
    r"\b(?:e[- ]?mail(?: address)?|username|user name|first name|last name|"
    r"display name|subscriber address|subscription endpoint|password|passphrase|"
    r"client secret|secret access key|access key(?: id)?|session token|api key|"
    r"authorization token|refresh token|private key)\b", re.I
)
PRIVATE_VALUE = re.compile(
    r"[\w.!#$%&'*+/=?^\x60{|}~-]+@[\w.-]+\.[a-z]{2,}"
    r"|\b(?:AKIA|ASIA|AIDA|ABIA|ACCA|AGPA|AIPA|ANPA|ANVA|APKA|AROA|ASCA)[A-Z0-9]{16}\b"
    r"|\barn:aws(?:-[^:]+)?:iam::\d+:user/[^\s,;\"]+"
    r"|\b(?:ghp_|github_pat_|xox[baprs]-)[\w-]{15,}"
    r"|\b[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----", re.I
)
SECRET_ASSIGNMENT = re.compile(
    r"""(?:["']?(?:password|passphrase|secret[_ -]?(?:access[_ -]?key|value)|client[_ -]?secret|api[_ -]?key|access[_ -]?token|session[_ -]?token|authorization)["']?)\s*[:=]\s*[^\s,;}]+"""
    r"|[?&](?:X-Amz-Signature|X-Amz-Security-Token)=[^\s&]+"
    r"|://[^\s/@]+:[^\s/@]+@", re.I
)


def clean(value, label=""):
    if value is None or value == "":
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bool):
        return str(value).upper()
    text = str(value)
    if PRIVATE_COLUMN.search(label) or PRIVATE_VALUE.search(text) or SECRET_ASSIGNMENT.search(text):
        return REDACTED
    return text.strip()


def worksheet_columns(rows, title, known_fields):
    header = None
    if title.lower() not in GRID_TABS:
        candidates = [
            (number, cells) for number, cells in rows[:10]
            if sum(isinstance(value, str) and bool(value.strip()) for value in cells) >= 2
            and all(isinstance(value, str) for value in cells if value is not None)
        ]
        header = next((row for row in candidates
                       if len(known_fields.intersection(row[1])) >= 2),
                      candidates[0] if candidates else None)
    header_number, headings = header or (0, ())
    used_columns = sorted({index for _, row in rows for index, value in enumerate(row)
                           if value is not None and value != ""})
    labels = []
    for index in used_columns:
        letter = get_column_letter(index + 1)
        original = clean(headings[index]) if index < len(headings) else ""
        label = original if original and original != REDACTED else f"Column {letter}"
        if label in labels:
            label = f"{label} ({letter})"
        labels.append(label)
    return header_number, list(zip(used_columns, labels))


def first_match(fields, pattern):
    return next((value for label, value in fields.items()
                 if value and value != REDACTED and re.fullmatch(pattern, label, re.I)), "")


def parse_sheet(sheet, service, known_fields):
    if sheet.title in PRIVATE_TABS.get(service, set()):
        return {"name": sheet.title, "withheld": True}, []
    rows = [(number, row) for number, row in enumerate(sheet.iter_rows(values_only=True), 1)
            if any(value is not None and value != "" for value in row)]
    header, columns = worksheet_columns(rows, sheet.title, known_fields)
    entries = []
    for number, row in rows:
        if number <= header:
            continue
        fields = {label: clean(row[index], label) for index, label in columns
                  if index < len(row) and row[index] is not None and row[index] != ""}
        if not fields:
            continue
        name = first_match(fields, r"(?:.* )?(?:name|id)") or next(
            (value for value in fields.values() if value != REDACTED), f"Worksheet row {number}"
        )
        entries.append({
            "id": f"workbook:{service}:{sheet.title}:{number}",
            "name": name, "service": service, "sheet": sheet.title, "row": number,
            "region": first_match(fields, r"(?:aws )?region"),
            "environment": first_match(fields, r"environment|env\.?"),
            "status": first_match(fields, r"(?:.* )?(?:status|state)(?: \(auto\))?") or "Recorded",
            "fields": fields,
        })
    tab = {"name": sheet.title, "columns": [label for _, label in columns]}
    return tab, entries


def main():
    baseline = (ASSETS / "data.js").read_text(encoding="utf-8-sig").strip()
    inventory = json.loads(baseline.removeprefix("window.orion = ").removesuffix(";"))
    known = defaultdict(set)
    for record in inventory["records"]:
        known[record["service"], record["sheet"]].update(record["fields"])

    tabs = {}
    records = []
    for service, source in inventory["sources"].items():
        workbook = load_workbook(WORKBOOKS / source["file"], read_only=True,
                                 data_only=True, keep_links=False)
        try:
            tabs[service] = []
            for sheet in workbook:
                tab, entries = parse_sheet(sheet, service, known[service, sheet.title])
                tabs[service].append(tab)
                records.extend(entries)
        finally:
            workbook.close()
    temporary = OUTPUT.with_suffix(".tmp")
    temporary.write_text(
        "window.orionWorkbookData = " + json.dumps({"tabs": tabs, "records": records},
                                                    ensure_ascii=True, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    temporary.replace(OUTPUT)
    print(f"{len(tabs)} workbooks, {sum(map(len, tabs.values()))} tabs, {len(records)} worksheet rows")


if __name__ == "__main__":
    main()
