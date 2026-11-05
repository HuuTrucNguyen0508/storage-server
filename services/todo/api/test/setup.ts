import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
export default async function setup() {
  const container = execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "-e",
      "POSTGRES_PASSWORD=test",
      "-p",
      "127.0.0.1::5432",
      "postgres:18.6-alpine3.24",
    ],
    { encoding: "utf8" },
  ).trim();
  const port = execFileSync("docker", ["port", container, "5432"], {
    encoding: "utf8",
  })
    .trim()
    .split(":")
    .at(-1);
  process.env.DATABASE_URL = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  for (let i = 0; i < 60; i++) {
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return () => {
        execFileSync("docker", ["stop", container]);
      };
    } catch {
      await setTimeout(500);
    }
  }
  execFileSync("docker", ["stop", container]);
  throw new Error("Test database failed to start");
}
