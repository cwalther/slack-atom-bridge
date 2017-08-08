# Slack to Atom Bridge
by Christian Walther <cwalther@gmx.ch>

This bridge script reads Slack content using the Slack API and converts it into a number of Atom feeds. This is useful for local archival, in particular to save content from the 10000 messages limit of Slack’s free plan.

How to use:

1. `npm install`

2. Obtain an access token for your account on the desired Slack team. A [legacy token](https://api.slack.com/custom-integrations/legacy-tokens) works, more secure is an [OAuth token](https://api.slack.com/docs/oauth) with read-only permissions.

3. Create a configuration file containing the access token and the port to listen on in JSON:
`myteam.json`
```
{
	"token": "xoxp-23984754863-2348975623103",
	"port": 8283
}
```

4. Run `node index.js myteam.json`, passing the name of the configuration file.

5. Subscribe to feed _http://localhost:8283/channels.xml_, which gives you a list of available channels, each with a link to the respective channel feed. These look like _http://localhost:8283/channel.xml?id=G5T4DBP3N&count=30_, where the _count_ argument can be adjusted to the desired number of latest messages on the feed.
