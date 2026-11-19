// Properties of the example app: promises that must hold whatever has happened before.

export const properties = {
  // The count in the status line matches the items on the page.
  async countMatchesList(url) {
    await fetch(`${url}/api/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `item ${Math.random()}` }) });
    const html = await (await fetch(url)).text();
    const count = Number(html.match(/<p role="status">(\d+) items?<\/p>/)?.[1]);
    return count === (html.match(/<li>/g) ?? []).length;
  },
};
