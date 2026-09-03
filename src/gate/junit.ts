// Hand-written JUnit XML walker. Handles the vitest and pytest (xunit2) shapes:
// <testsuites>/<testsuite>/<testcase> with <failure>, <error>, <skipped> children,
// comments, <?xml ?>, CDATA and the five standard entities plus numeric refs.

export type JunitStatus = "passed" | "failed" | "error" | "skipped";

export interface JunitCase {
  id: string;
  classname: string;
  name: string;
  suite: string;
  status: JunitStatus;
  timeSeconds: number;
  message?: string;
}

export interface JunitCounts {
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
}

export interface JunitReport {
  cases: JunitCase[];
  counts: JunitCounts;
  collectionErrors: string[];
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole: string, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

export function junitCaseId(classname: string, name: string): string {
  return classname.length > 0 ? `${classname}::${name}` : name;
}

export function findCase(report: JunitReport, id: string): JunitCase | undefined {
  return report.cases.find((c) => c.id === id);
}

const TAG_RE = /<(\/)?([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)\s*(\/)?>/y;
const ATTR_RE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const STATUS_RANK: Record<JunitStatus, number> = { passed: 0, skipped: 1, failed: 2, error: 3 };
const MESSAGE_CAP = 2000;

interface Detail {
  kind: "failure" | "error" | "skipped";
  message: string | undefined;
  text: string;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    attrs[m[1] ?? ""] = decodeXml(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return "";
}

export function parseJunit(xml: string): JunitReport {
  const cases: JunitCase[] = [];
  const suites: string[] = [];
  let current: JunitCase | null = null;
  let detail: Detail | null = null;

  const closeDetail = (): void => {
    if (current !== null && detail !== null) {
      const status: JunitStatus = detail.kind === "failure" ? "failed" : detail.kind;
      if (STATUS_RANK[status] > STATUS_RANK[current.status]) {
        current.status = status;
        const message = (detail.message ?? "").trim() || firstLine(detail.text);
        current.message = message.slice(0, MESSAGE_CAP);
      }
    }
    detail = null;
  };

  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;
    if (detail !== null && lt > i) detail.text += decodeXml(xml.slice(i, lt));

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (detail !== null) detail.text += xml.slice(lt + 9, end === -1 ? n : end);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }

    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(xml);
    if (m === null) {
      i = lt + 1;
      continue;
    }
    i = TAG_RE.lastIndex;
    const closing = m[1] === "/";
    const name = m[2] ?? "";
    const attrs = parseAttrs(m[3] ?? "");
    const selfClosing = m[4] === "/";

    if (name === "testsuite") {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attrs["name"] ?? "");
      continue;
    }
    if (name === "testcase") {
      if (closing) {
        closeDetail();
        if (current !== null) cases.push(current);
        current = null;
        continue;
      }
      const classname = attrs["classname"] ?? "";
      const caseName = attrs["name"] ?? "";
      current = {
        id: junitCaseId(classname, caseName),
        classname,
        name: caseName,
        suite: suites[suites.length - 1] ?? "",
        status: "passed",
        timeSeconds: Number(attrs["time"] ?? "0") || 0,
      };
      if (selfClosing) {
        cases.push(current);
        current = null;
      }
      continue;
    }
    if (name === "failure" || name === "error" || name === "skipped") {
      if (closing) {
        closeDetail();
        continue;
      }
      detail = { kind: name, message: attrs["message"], text: "" };
      if (selfClosing) closeDetail();
    }
  }

  const counts: JunitCounts = { total: cases.length, passed: 0, failed: 0, error: 0, skipped: 0 };
  for (const c of cases) counts[c.status] += 1;
  const collectionErrors = cases
    .filter(
      (c) =>
        c.status === "error" &&
        (c.classname === "" || c.classname === c.name || /collect/i.test(c.message ?? "")),
    )
    .map((c) => c.id);
  return { cases, counts, collectionErrors };
}
