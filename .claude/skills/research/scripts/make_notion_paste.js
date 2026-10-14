// 리서치 md를 노션에 붙여넣는 Playwright MCP용 코드 파일을 만든다.
// usage: node make_notion_paste.js <md 절대경로> [노션 부모 페이지(데이터베이스) URL]
// 결과: <프로젝트>/.playwright-mcp/notion_paste.js
//   → mcp__playwright__browser_run_code_unsafe(filename: ".playwright-mcp/notion_paste.js") 로 실행
const fs = require('fs');
const path = require('path');

const [mdPath, parentUrl] = process.argv.slice(2);
if (!mdPath) {
  console.error('usage: node make_notion_paste.js <md 절대경로> [노션 부모 URL]');
  process.exit(1);
}

const lines = fs.readFileSync(mdPath, 'utf8').split(/\r?\n/);
const title = lines[0].replace(/^#\s*/, '');
const body = lines.slice(1).join('\n').trim();

const code = `async (page) => {
  const title = ${JSON.stringify(title)};
  const body = ${JSON.stringify(body)};
  const parentUrl = ${JSON.stringify(parentUrl || '')};
  if (parentUrl) {
    await page.goto(parentUrl);
    await page.waitForTimeout(4000);
  }
  await page.getByRole("button", { name: "새로 만들기" }).first().click();
  await page.waitForTimeout(3000);
  await page.locator('[contenteditable="true"][placeholder="새 페이지"]').first().click();
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, body);
  await page.waitForTimeout(5000);
  await page.keyboard.press("Escape");
  const info = await page.evaluate(() => {
    const t = document.querySelector("main")?.innerText || "";
    return "tables=" + document.querySelectorAll("main table, main .notion-table-block").length
      + " todos=" + document.querySelectorAll("main .notion-to_do-block").length
      + " hasSummary=" + t.includes("한 줄 요약");
  });
  return page.url() + " | " + (await page.title()) + " | " + info;
}`;

const outDir = path.resolve(__dirname, '../../../../.playwright-mcp');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'notion_paste.js');
fs.writeFileSync(outPath, code);
console.log(outPath);
