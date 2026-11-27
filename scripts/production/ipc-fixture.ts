// Private protocol fixture: no MCP, browser, or standard-stream parsing.
process.on("message", (message: any) => {
  if (message.method === "shutdown") {
    process.send!({ id: message.id, result: null });
    process.disconnect?.();
    process.exit(0);
  }
  if (message.name === "crash") process.exit(17);
  if (message.name === "hang") return;
  // Noise on stdout must not be mistaken for a response.
  console.log("not a protocol message");
  setTimeout(() => process.send!({ id: message.id, result: {
    content: [{ type: "text", text: String(message.args?.value) }],
  } }), message.args?.delay || 0);
});
process.send!({ ready: true });
process.on("disconnect", () => process.exit(0));
