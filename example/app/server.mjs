// A tiny shopping list with no dependencies, used by the end-to-end test and as a
// worked example. REJECT_BLANK is the "fix" the example acceptance spec checks.
import { createServer } from "node:http";

const REJECT_BLANK = true;
let items = [];

const page = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Shopping list</title></head>
<body>
  <h1>Shopping list</h1>
  <p role="status">${items.length} ${items.length === 1 ? "item" : "items"}</p>
  <section aria-label="Items"><ul>${items.map((item) => `<li>${item.replace(/[<&]/g, (c) => `&#${c.charCodeAt(0)};`)}</li>`).join("")}</ul></section>
  <form aria-label="Add item">
    <p id="message" role="alert" hidden></p>
    <label>Item name <input name="name"></label>
    <button>Add</button>
  </form>
  <script>
    const form = document.querySelector("form");
    const message = document.getElementById("message");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = form.name.value.trim();
      if (${REJECT_BLANK} && !name) {
        message.textContent = "Enter a name for the item.";
        message.hidden = false;
        return;
      }
      await fetch("/api/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      location.reload();
    });
  </script>
</body></html>`;

const server = createServer(async (request, response) => {
  const send = (status, type, body) => response.writeHead(status, { "Content-Type": type }).end(body);
  if (request.url === "/health") return send(200, "text/plain", "ok");
  if (request.url === "/" && request.method === "GET") return send(200, "text/html", page());
  if (request.url === "/api/items" && request.method === "GET") return send(200, "application/json", JSON.stringify(items));
  if (request.url === "/api/items" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    items.push(String(JSON.parse(body).name ?? ""));
    return send(201, "application/json", JSON.stringify(items));
  }
  if (request.url === "/api/reset" && request.method === "POST") {
    items = [];
    return send(204, "text/plain", "");
  }
  send(404, "text/plain", "Not found");
});
server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1");
