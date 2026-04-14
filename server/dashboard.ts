// server/dashboard.ts stub — full implementation in Plan C Task 6
export function getDashboardHtml(baseUrl: string): string {
  return `<!DOCTYPE html><html><body><h1>pi-engteam observer</h1><p>API: <a href="${baseUrl}/runs">${baseUrl}/runs</a></p></body></html>`;
}
