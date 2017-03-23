var express = require('express');
var app = express();

var WebClient = require('@slack/client').WebClient;

var config = {
	'fablabwinti': {
		token: 'your-token-here',
		port: 8283
	},
	'fablabzurich': {
		token: 'your-token-here',
		port: 8284
	}
}[process.argv[2]];

var slack = new WebClient(config.token);

var Feed = require('feed');

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
var getImList = makeResponseCache(() => slack.im.list());

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
	
	res.type('application/atom+xml').send(feed.render('atom-1.0'));
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
	Promise.all([slack.channels.list(), slack.groups.list(), getImList(), getTeamInfo(), getUsersList()])
	.then(args => {
		var channels = args[0].channels;
		var groups = args[1].groups;
		var ims = args[2].ims;
		var team = args[3].team;
		var users = args[4].members;
		
		for (var channel of channels) channelsByIdCache[channel.id] = channel;
		
		var usersById = {};
		for (var u of users) usersById[u.id] = u;
		
		var feedUrl = 'http://' + (req.headers.host || 'localhost') + '/';
		
		items = [];
		for (var channel of channels) {
			items.push(channelItem(channel, usersById, team, feedUrl));
		}
		for (var group of groups) {
			items.push(channelItem(group, usersById, team, feedUrl));
		}
		for (var im of ims) {
			items.push(channelItem(im, usersById, team, feedUrl));
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
		
		res.type('application/atom+xml').send(feed.render('atom-1.0'));
	})
	.catch(e => {
		res.status(500).send(e.toString() + '\n' + e.stack);
	});
});

app.get('/channel.xml', (req, res) => {
	var channelid = req.query.id;
	var count = req.query.count || 30;
	if (!channelid) {
		res.status(404).send('id parameter needed\n');
	}
	else if (channelid.startsWith('C')) {
		Promise.all([slack.channels.info(channelid), slack.channels.history(channelid, {count: count}), getTeamInfo(), getUsersList()])
		.then(args => {
			info = args[0].channel;
			info.name_display_prefix = '#';
			sendChannelFeed(req, res, count, info, args[1].messages, args[2].team, args[3].members);
		})
		.catch(e => {
			res.status(500).send(e.toString() + '\n' + e.stack);
		});
	}
	else if (channelid.startsWith('G')) {
		Promise.all([slack.groups.info(channelid), slack.groups.history(channelid, {count: count}), getTeamInfo(), getUsersList()])
		.then(args => {
			info = args[0].group;
			info.name_display_prefix = info.is_mpim ? '' : '=';
			sendChannelFeed(req, res, count, info, args[1].messages, args[2].team, args[3].members);
		})
		.catch(e => {
			res.status(500).send(e.toString() + '\n' + e.stack);
		});
	}
	else if (channelid.startsWith('D')) {
		Promise.all([getImList(), slack.im.history(channelid, {count: count}), getTeamInfo(), getUsersList()])
		.then(args => {
			var info = { id: channelid, name: 'unknown IM', name_display_prefix: '@' };
			for (var i of args[0].ims) {
				if (i.id == channelid) {
					for (var u of args[3].members) {
						if (u.id == i.user) {
							info.name = u.name;
							break;
						}
					}
					break;
				}
			}
			sendChannelFeed(req, res, count, info, args[1].messages, args[2].team, args[3].members);
		})
		.catch(e => {
			res.status(500).send(e.toString() + '\n' + e.stack);
		});
	}
	else {
		res.status(404).send('unknown id type ' + channelid + '\n');
	}
});

app.listen(config.port, () => {
	console.log('listening on port ' + config.port);
});
