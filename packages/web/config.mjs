const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://tribunus.dev" : `https://${stage}.tribunus.dev`,
  console: stage === "production" ? "https://tribunus.dev/auth" : `https://${stage}.tribunus.dev/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/tribunus-dev/tribunus",
  discord: "https://tribunus.dev/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
