/*
Copyright (c) 2016 Christian Walther

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

var fs = require('fs');

var express = require('express');
var app = express();

var WebClient = require('@slack/web-api').WebClient;

var config = JSON.parse(fs.readFileSync(process.argv[2]));

var slack = new WebClient(config.token);

var Feed = require('feed').Feed;

// caches the result from a channel list request to avoid asynchronous lookups when title-less channels are mentioned in message texts
var channelsByIdCache = {};

function makeResponseCache(getter) {
	var cache = { time: 0, promise: null };
	return function() {
		var now = Date.now();
		if (now - cache.time > 60000) {
			cache.time = now;
			cache.promise = getter();
		}
		return cache.promise;
	}
}

var getTeamInfo = makeResponseCache(() => slack.team.info());
var getUsersList = makeResponseCache(() => slack.users.list());

function escapeHTML(s) {
	return s.replace(/[&"<>]/g, function (c) {
		return {
			'&': "&amp;",
			'"': "&quot;",
			'<': "&lt;",
			'>': "&gt;"
		}[c];
	});
}

function processMessageText(text, rich, usersById, team) {
	return text.replace(/</g, '‹').replace(/>/g, '›')
	.replace(
		/‹@(U[^|›]*)(\|([^›]*))?›/g,
		rich
		? (m, uid, g2, title) => {
			var u = usersById[uid];
			return '<a href="https://' + team.domain + '.slack.com/team/' + u.name + '" title="' + u.real_name + '">@' + (title || u.name) + '</a>';
		}
		: (m, uid, g2, title) => '@' + (title || usersById[uid].name)
	).replace(
		/‹#(C[^|›]*)(\|([^›]*))?›/g,
		// these are rare without a title (only if the channel is archived, possibly?)
		rich
		? (m, cid, g2, title) => {
			if (!title) {
				var c = channelsByIdCache[cid];
				if (c) title = c.name;
			}
			return '<a href="https://' + team.domain + '.slack.com/archives/' + (title || cid) + '">#' + (title || cid) + '</a>'
		}
		: (m, cid, g2, title) => {
			if (!title) {
				var c = channelsByIdCache[cid];
				if (c) title = c.name;
			}
			return '#' + (title || cid)
		}
	).replace(
		/‹([^|›]*)(\|([^›]*))?›/g,
		rich
		? (m, link, g2, title) => '<a href="' + link + '">' + (title || link) + '</a>'
		: (m, link, g2, title) => (title || link)
	).replace(/\n/g, '<br>');
}

function sendChannelFeed(req, res, count, info, messages, team, users) {
	var usersById = {};
	for (var u of users) usersById[u.id] = u;
	
	if (!info.name) {
		// happens on IMs (FIXME not good for links)
		info.name = usersById[info.user].name;
	}
	
	items = [];
	for (var message of messages) {
		var title = processMessageText(message.text || '', false, usersById, team);
		var end = title.indexOf('\n');
		if (end >= 0 && end < 80) {
			title = title.substring(0, end) + ' …';
		}
		else if (title.length > 80) {
			title = title.substring(0, 80) + '…';
		}
		var author = null;
		if (message.user) {
			author = usersById[message.user];
		}
		if (!author) {
			author = { name: message.bot_id || 'unknown', real_name: message.username || 'Unknown User', profile: { email: 'user@example.com' } };
		}
		var content = '<p>' + processMessageText(message.text || '', true, usersById, team) + '</p>';
		if (message.subtype) {
			content += '<p style="font-size: 80%; color: #666666;">' + message.subtype + '</p>';
		}
		if (message.parent_user_id) {
			content += '<p style="font-size: 80%; color: #666666;">reply to ' + (usersById[message.parent_user_id].real_name || usersById[message.parent_user_id].name)  + '</p>';
		}
		items.push({
			author: [{
				name: author.real_name + ' (' + author.name + ')',
				email: author.profile.email,
				link: 'https://' + team.domain + '.slack.com/team/' + author.name
			}],
			link: 'https://' + team.domain + '.slack.com/archives/' + info.name + '/p' + 1000000*message.ts,
			title: title,
			date: new Date(1000*message.ts),
			content: content
		});
	}
	if (items.length == 0) {
		// Vienna doesn't like empty feeds (it treats that as an error and ignores even the feed properties)
		items.push({
			author: [{
				name: 'Slack-Atom Bridge',
				email: 'nobody@example.com'
			}],
			link: 'about:blank',
			title: 'Empty',
			date: new Date(0),
			content: 'This feed contains no messages!'
		});
	}
	items.sort((i1, i2) => (i1.date < i2.date) ? 1 : (i1.date > i2.date) ? -1 : 0);
	
	feed = new Feed({
		title: 'Slack / ' + team.name + ' / ' + info.name_display_prefix + info.name,
		link: 'https://' + team.domain + '.slack.com/archives/' + info.name,
		id: 'https://' + team.domain + '.slack.com/archives/' + info.name,
		feed: 'http://' + (req.headers.host || 'localhost') + '/channel.xml?id=' + info.id + '&count=' + count,
		icon: team.icon.image_34,
		updated: (items.length == 0) ? undefined : items[0].date
	});
	for (var i of items) feed.addItem(i);
	
	res.type('application/atom+xml').send(feed.atom1());
}

function channelItem(channel, usersById, team, feedUrl) {
	var content;
	var title;
	var weblink;
	var author;
	
	if (channel.name) {
		// not set for ims
		weblink = 'https://' + team.domain + '.slack.com/archives/' + channel.name;
	}
	if (channel.creator) {
		// not set for ims
		author = usersById[channel.creator];
	}
	
	if (channel.is_mpim) {
		content = '<p><strong>Multiparty Direct Message Channel:</strong> ';
		var first = true;
		for (var m of channel.members) {
			if (!first) content += ', ';
			content += usersById[m].real_name;
			first = false;
		}
		content += '</p>';
		title = channel.name
	}
	else if (channel.is_group) {
		content = '<p><strong>Private Channel:</strong> ' + channel.name + '</p>';
		title = '=' + channel.name;
	}
	else if (channel.is_im) {
		author = usersById[channel.user];
		content = '<p><strong>Direct Message Channel:</strong> ' + author.real_name + '</p>';
		title = '@' + author.name;
		weblink = 'https://' + team.domain + '.slack.com/archives/' + author.name;
	}
	else {
		content = '<p><strong>Channel:</strong> #' + channel.name + '</p>';
		title = '#' + channel.name
	}
	if (channel.topic && channel.topic.value) {
		content += '<p><strong>Topic:</strong> ' + channel.topic.value;
		if (channel.topic.creator && channel.topic.last_set) {
			content += ' <span style="font-size: 80%; color: #666666;">(' + usersById[channel.topic.creator].name + ', ' + new Date(1000*channel.topic.last_set).toISOString().substring(0,10) + ')</span>';
		}
		content += '</p>';
	}
	if (channel.purpose && channel.purpose.value) {
		content += '<p><strong>Purpose:</strong> ' + channel.purpose.value;
		if (channel.purpose.creator && channel.purpose.last_set) {
			content += ' <span style="font-size: 80%; color: #666666;">(' + usersById[channel.purpose.creator].name + ', ' + new Date(1000*channel.purpose.last_set).toISOString().substring(0,10) + ')</span>';
		}
		content += '</p>';
	}
	var feedlink = feedUrl + 'channel.xml?id=' + channel.id + '&count=30';
	content += '<p style="font-size: 80%; color: #666666;"><a href="' + feedlink + '">feed</a>';
	if (weblink) {
		content += ' • <a href="' + weblink + '">web</a>';
	}
	content += '</p>';
	return {
		author: [{
			name: author.real_name + ' (' + author.name + ')',
			email: author.profile.email,
			link: 'https://' + team.domain + '.slack.com/team/' + author.name
		}],
		link: feedlink,
		title: title,
		date: new Date(1000*channel.created),
		content: content
	};
}

app.get('/channels.xml', (req, res) => {
	Promise.all([
		// for mpims we additionally want the members - the old groups.list API included that, but conversations.list does not
		slack.conversations.list({types: 'public_channel,private_channel,mpim,im'})
		.then(result => Promise.all(result.channels.filter(c => c.is_mpim).map(c => slack.conversations.members({channel: c.id}).then(m => { c.members = m.members; })))
			.then(_ => result)
		),
		getTeamInfo(),
		getUsersList()
	])
	.then(([{channels}, {team}, {members: users}]) => {
		for (var channel of channels) channelsByIdCache[channel.id] = channel;
		
		var usersById = {};
		for (var u of users) usersById[u.id] = u;
		
		var feedUrl = 'http://' + (req.headers.host || 'localhost') + '/';
		
		items = [];
		for (var channel of channels) {
			items.push(channelItem(channel, usersById, team, feedUrl));
		}
		items.sort((i1, i2) => (i1.date < i2.date) ? 1 : (i1.date > i2.date) ? -1 : 0);
		
		// feedvalidator says entries should have unique updated time stamps, which our #general and #random don't
		do {
			var changed = false;
			for (var i = 1; i < items.length; i++) {
				if (items[i].date.getTime() == items[i-1].date.getTime()) {
					items[i-1].date = new Date(items[i-1].date.getTime() + 1000);
					changed = true;
				}
			}
		} while (changed);
		
		feed = new Feed({
			title: 'Slack / ' + team.name + ' / Channels',
			link: 'https://' + team.domain + '.slack.com/',
			id: 'https://' + team.domain + '.slack.com/',
			feed: feedUrl + 'channels.xml',
			icon: team.icon.image_34,
			updated: (items.length == 0) ? undefined : items[0].date
		});
		for (var i of items) feed.addItem(i);
		
		res.type('application/atom+xml').send(feed.atom1());
	})
	.catch(e => {
		res.status(500).send(e.toString() + '\n' + e.stack);
		console.log('Error building channels.xml:', e);
	});
});

app.get('/channel.xml', (req, res) => {
	var channelid = req.query.id;
	var count = req.query.count || 30;
	if (!channelid) {
		res.status(404).send('id parameter needed\n');
	}
	else {
		Promise.all([
			slack.conversations.info({channel: channelid}),
			// for thread parents we additionally want the replies - the old channels.history API included those, but conversations.history does not
			// Note that this means we will miss new replies to old threads whose parent has already dropped out - I don't see any way around this in the API docs.
			slack.conversations.history({channel: channelid, count: count})
			.then(
				result => Promise.all(result.messages.filter(m => m.thread_ts !== undefined).map(
					m => slack.conversations.replies({channel: channelid, ts: m.thread_ts, limit: count})
					.then(replies => {
						for (var m of replies.messages) {
							if (!result.messages.find(rm => rm.ts == m.ts)) {
								result.messages.push(m);
							}
						}
					})
				))
				.then(_ => result)
			),
			getTeamInfo(),
			getUsersList()
		])
		.then(([{channel}, {messages}, {team}, {members}]) => {
			info = channel;
			info.name_display_prefix = channelid.startsWith('C') ? '#' : channelid.startsWith('D') ? '@' : channel.is_mpim ? '' : channelid.startsWith('G') ? '=' : '?';
			sendChannelFeed(req, res, count, info, messages, team, members);
		})
		.catch(e => {
			res.status(500).send(e.toString() + '\n' + e.stack);
		});
	}
});

app.listen(config.port, () => {
	console.log('listening on port ' + config.port);
});
