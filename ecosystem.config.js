module.exports = {
  apps: [
    { name: "shopify-kiotviet-web", script: "node_modules/next/dist/bin/next", args: "start", cwd: "/var/www/shopify-kiotviet", instances: 1, autorestart: true, max_memory_restart: "750M", env: { NODE_ENV: "production", PORT: "3000" }, error_file: "/var/log/shopify-kiotviet/web-error.log", out_file: "/var/log/shopify-kiotviet/web-out.log", time: true },
    { name: "shopify-kiotviet-worker", script: "node_modules/tsx/dist/cli.mjs", args: "src/worker.ts", cwd: "/var/www/shopify-kiotviet", instances: 1, autorestart: true, max_memory_restart: "750M", kill_timeout: 30000, env: { NODE_ENV: "production" }, error_file: "/var/log/shopify-kiotviet/worker-error.log", out_file: "/var/log/shopify-kiotviet/worker-out.log", time: true },
    { name: "shopify-kiotviet-scheduler", script: "node_modules/tsx/dist/cli.mjs", args: "src/scheduler.ts", cwd: "/var/www/shopify-kiotviet", instances: 1, autorestart: true, max_memory_restart: "300M", env: { NODE_ENV: "production" }, error_file: "/var/log/shopify-kiotviet/scheduler-error.log", out_file: "/var/log/shopify-kiotviet/scheduler-out.log", time: true },
  ],
};
