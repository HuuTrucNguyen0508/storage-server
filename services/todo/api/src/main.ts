import { buildApp } from "./app.js";
const { app, metricServer } = await buildApp();
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
metricServer.listen(Number(process.env.METRICS_PORT ?? 9464), "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
