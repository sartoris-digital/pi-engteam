import { describe, it, expect } from "vitest";
import { parseJunit, junitCaseId, findCase } from "../../../src/gate/junit.js";

const VITEST_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="4" failures="1" errors="0" time="0.052">
    <testsuite name="tests/unit/math.test.ts" timestamp="2026-09-02T10:00:00.000Z" hostname="ci" tests="4" failures="1" errors="0" skipped="1" time="0.05">
        <testcase classname="tests/unit/math.test.ts" name="math &gt; adds" time="0.001">
        </testcase>
        <testcase classname="tests/unit/math.test.ts" name="math &gt; subtracts" time="0.002">
            <failure message="expected 1 to be 2 // Object.is equality" type="AssertionError">
AssertionError: expected 1 to be 2 // Object.is equality
 ❯ tests/unit/math.test.ts:9:22
            </failure>
        </testcase>
        <testcase classname="tests/unit/math.test.ts" name="math &gt; divides" time="0">
            <skipped/>
        </testcase>
        <testcase classname="tests/unit/math.test.ts" name="math &gt; multiplies" time="0.001"/>
    </testsuite>
</testsuites>
`;

const VITEST_SUITE_ERROR_XML = `<testsuites name="vitest tests" tests="1" failures="0" errors="1" time="0">
    <testsuite name="tests/unit/broken.test.ts" tests="1" failures="0" errors="1" skipped="0" time="0">
        <testcase classname="tests/unit/broken.test.ts" name="tests/unit/broken.test.ts" time="0">
            <error message="Failed to load url ./missing.js" type="Error">Error: Failed to load url ./missing.js</error>
        </testcase>
    </testsuite>
</testsuites>
`;

const PYTEST_XML = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
<testsuite name="pytest" errors="2" failures="1" skipped="1" tests="5" time="0.031" timestamp="2026-09-02T10:00:00.000000" hostname="ci">
<testcase classname="tests.test_math" name="test_adds" time="0.001" />
<testcase classname="tests.test_math" name="test_subtracts" time="0.001"><failure message="assert 1 == 2">def test_subtracts():
&gt;       assert 1 == 2
E       assert 1 == 2

tests/test_math.py:7: AssertionError</failure></testcase>
<testcase classname="tests.test_math" name="test_divides" time="0.000"><skipped type="pytest.skip" message="not today">/w/tests/test_math.py:10: not today</skipped></testcase>
<testcase classname="tests.test_math" name="test_boom" time="0.000"><error message="failed on setup with &quot;RuntimeError: boom&quot;">traceback</error></testcase>
<testcase classname="" name="tests/test_broken.py" time="0.000"><error message="collection failure">ImportError while importing test module</error></testcase>
</testsuite>
</testsuites>
`;

describe("junitCaseId", () => {
  it("joins classname and name with :: and falls back to name", () => {
    expect(junitCaseId("tests.test_math", "test_adds")).toBe("tests.test_math::test_adds");
    expect(junitCaseId("", "tests/test_broken.py")).toBe("tests/test_broken.py");
  });
});

describe("parseJunit (vitest shape)", () => {
  it("parses statuses, ids, messages and counts", () => {
    const report = parseJunit(VITEST_XML);
    expect(report.counts).toEqual({ total: 4, passed: 2, failed: 1, error: 0, skipped: 1 });
    expect(report.collectionErrors).toEqual([]);

    const adds = findCase(report, "tests/unit/math.test.ts::math > adds");
    expect(adds?.status).toBe("passed");
    expect(adds?.suite).toBe("tests/unit/math.test.ts");
    expect(adds?.timeSeconds).toBeCloseTo(0.001);

    const subtracts = findCase(report, "tests/unit/math.test.ts::math > subtracts");
    expect(subtracts?.status).toBe("failed");
    expect(subtracts?.message).toBe("expected 1 to be 2 // Object.is equality");

    expect(findCase(report, "tests/unit/math.test.ts::math > divides")?.status).toBe("skipped");
    expect(findCase(report, "tests/unit/math.test.ts::math > multiplies")?.status).toBe("passed");
  });

  it("treats a suite-level load error as a collection error", () => {
    const report = parseJunit(VITEST_SUITE_ERROR_XML);
    expect(report.counts.error).toBe(1);
    expect(report.collectionErrors).toEqual(["tests/unit/broken.test.ts::tests/unit/broken.test.ts"]);
  });
});

describe("parseJunit (pytest shape)", () => {
  it("parses self-closing cases, skipped messages, errors and collection failures", () => {
    const report = parseJunit(PYTEST_XML);
    expect(report.counts).toEqual({ total: 5, passed: 1, failed: 1, error: 2, skipped: 1 });
    expect(findCase(report, "tests.test_math::test_adds")?.status).toBe("passed");
    expect(findCase(report, "tests.test_math::test_subtracts")?.status).toBe("failed");
    expect(findCase(report, "tests.test_math::test_subtracts")?.message).toBe("assert 1 == 2");
    expect(findCase(report, "tests.test_math::test_divides")?.status).toBe("skipped");
    expect(findCase(report, "tests.test_math::test_divides")?.message).toBe("not today");
    expect(findCase(report, "tests.test_math::test_boom")?.status).toBe("error");
    expect(findCase(report, "tests.test_math::test_boom")?.message).toBe('failed on setup with "RuntimeError: boom"');
    expect(findCase(report, "tests/test_broken.py")?.status).toBe("error");
    expect(report.collectionErrors).toEqual(["tests/test_broken.py"]);
  });
});

describe("parseJunit (edge cases)", () => {
  it("uses the first non-empty text line as the message when there is no message attribute", () => {
    const xml = `<testsuite name="s"><testcase classname="c" name="n"><failure><![CDATA[
Boom happened
second line]]></failure></testcase></testsuite>`;
    const report = parseJunit(xml);
    expect(findCase(report, "c::n")?.status).toBe("failed");
    expect(findCase(report, "c::n")?.message).toBe("Boom happened");
  });

  it("ignores comments, system-out and unknown elements", () => {
    const xml = `<!-- generated --><testsuite name="s">
      <properties><property name="x" value="y"/></properties>
      <testcase classname="c" name="ok"><system-out>noise &lt;tag&gt;</system-out></testcase>
    </testsuite>`;
    const report = parseJunit(xml);
    expect(report.counts).toEqual({ total: 1, passed: 1, failed: 0, error: 0, skipped: 0 });
  });

  it("returns an empty report for empty or non-junit input", () => {
    expect(parseJunit("").counts.total).toBe(0);
    expect(parseJunit("not xml at all").counts.total).toBe(0);
  });

  it("error outranks failure outranks skipped inside one testcase", () => {
    const xml = `<testsuite name="s"><testcase classname="c" name="n"><skipped/><failure message="f"/><error message="e"/></testcase></testsuite>`;
    const c = findCase(parseJunit(xml), "c::n");
    expect(c?.status).toBe("error");
    expect(c?.message).toBe("e");
  });
});
