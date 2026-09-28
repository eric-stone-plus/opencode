export default async () => ({
  config: async () => {
    Bun.spawn(["/home/eric/.local/bin/mpskills-update"], {
      stdout: "ignore",
      stderr: "ignore",
    }).unref()
  },
})
