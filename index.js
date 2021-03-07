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

var { WebClient, ErrorCode } = require('@slack/web-api');

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
	).replace(/\r?\n/g, '<br>');
}

function decodeTinyThumb(thumb_tiny) {
	var data = Buffer.from(thumb_tiny, 'base64');
	var header;
	var offset;
	switch (data[0]) {
		case 1:
			header = Buffer.from("/9j/2wCEAHJPVmRWR3JkXWSBeXKIq/+6q52dq//6/8////////////////////////////////////////////////////8BeYGBq5ar/7q6///////////////////////////////////////////////////////////////////////////AABEIAAAAAAMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AA==", 'base64'),
			offset = 141;
			break;
		case 2:
			header = Buffer.from("/9j/2wCEAFA3PEY8MlBGQUZaVVBfeMiCeG5uePWvuZHI//////////////////////////////////////////////////8BVVpaeGl464KC6//////////////////////////////////////////////////////////////////////////AABEIAAAAAAMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AA==", 'base64'),
			offset = 141;
			break;
		case 3:
			header = Buffer.from("/9j/2wCEADUlKC8oITUvKy88OTU/UIVXUElJUKN1e2GFwarLyL6qurfV8P//1eL/5re6////////////zv////////////8BOTw8UEZQnVdXnf/cutz////////////////////////////////////////////////////////////////////AABEIAAAAAAMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AA==", 'base64'),
			offset = 141;
			break;
		case 4:
			header = Buffer.from("/9j/2wCEACgcHiMeGSgjISMtKygwPGRBPDc3PHtYXUlkkYCZlo+AjIqgtObDoKrarYqMyP/L2u71////m8H////6/+b9//gBKy0tPDU8dkFBdviljKX4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+P/AABEIAAAAAAMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AA==", 'base64'),
			offset = 141;
			break;
		case 5:
			header = Buffer.from("/9j/2wCEACAWGBwYFCAcGhwkIiAmMFA0MCwsMGJGSjpQdGZ6eHJmcG6AkLicgIiuim5woNqirr7EztDOfJri8uDI8LjKzsYBIiQkMCowXjQ0XsaEcITGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxv/AABEIAAAAAAMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AA==", 'base64'),
			offset = 141;
			break;
		case 6:
			header = Buffer.from("/9j/2wCEABsSFBcUERsXFhceHBsgKEIrKCUlKFE6PTBCYFVlZF9VXVtqeJmBanGQc1tdhbWGkJ6jq62rZ4C8ybqmx5moq6QBHB4eKCMoTisrTqRuXW6kpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpP/AABEIAAAAAAMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AA==", 'base64'),
			offset = 141;
			break;
		default:
			return 'Unrecognized thumb_tiny: ' + thumb_tiny;
	}
	var dimensions = data.slice(1, 5);
	dimensions.copy(header, offset);
	return 'data:image/jpeg;base64,' + Buffer.concat([header, data.slice(5)]).toString('base64');
}

function sendChannelFeed(req, res, count, info, messages, team, users) {
	var usersById = {};
	for (var u of users) usersById[u.id] = u;
	
	if (!info.name) {
		// happens on IMs; this replacement is good for links, not so much for human-readable places
		info.name = info.id;
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
		if (message.files) {
			content += '<ul>';
			for (f of message.files) {
				content += '<li>';
				if (f.thumb_tiny) content += '<img src="' + decodeTinyThumb(f.thumb_tiny) + '" style="vertical-align: middle;"> ';
				content += '<strong>' + escapeHTML(f.title || f.name) + '</strong> &nbsp;•&nbsp; <em title="' + escapeHTML(f.filetype + ', ' + f.mimetype + ', ' + f.size + 'B') + '">' + f.pretty_type + '</em>';
				if (f.original_w && f.original_h) content += ' ' + f.original_w + '×' + f.original_h;
				if (f.url_private) content += ' &nbsp;•&nbsp; <a href="' + escapeHTML(f.url_private) + '">private</a>';
				if (f.permalink) content += ' &nbsp;•&nbsp; <a href="' + escapeHTML(f.permalink) + '">permalink</a>';
				if (f.permalink_public) content += ' &nbsp;•&nbsp; <a href="' + escapeHTML(f.permalink_public) + '">perma public</a>';
				if (f.preview) content += '<pre style="white-space: pre-wrap;">' + escapeHTML(f.preview) + '</pre>' + (f.preview_is_truncated || f.lines_more ? ' …' : '')
				content += '</li>';
			}
			content += '</ul>';
		}
		if (message.subtype) {
			content += '<p style="font-size: 80%; color: #666666;">' + message.subtype + '</p>';
		}
		if (message.parent_user_id) {
			content += '<p style="font-size: 80%; color: #666666;">reply to ' + (usersById[message.parent_user_id].real_name || usersById[message.parent_user_id].name)  + '</p>';
		}
		items.push({
			author: [{
				name: author.real_name ? (author.real_name + ' (' + author.name + ')') : author.name,
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
		title: 'Slack / ' + team.name + ' / ' + info.name_display_prefix + (info.is_im ? usersById[info.user].name : info.name),
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
			content += (usersById[m].real_name || usersById[m].name);
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
		content = '<p><strong>Direct Message Channel:</strong> ' + (author.real_name || author.name) + '</p>';
		title = '@' + author.name;
		weblink = 'https://' + team.domain + '.slack.com/archives/' + channel.id;
	}
	else {
		content = '<p><strong>Channel:</strong> #' + channel.name + '</p>';
		title = '#' + channel.name
	}
	if (channel.topic && channel.topic.value) {
		content += '<p><strong>Topic:</strong> ' + processMessageText(channel.topic.value, true, usersById, team);
		if (channel.topic.creator && channel.topic.last_set) {
			content += ' <span style="font-size: 80%; color: #666666;">(' + usersById[channel.topic.creator].name + ', ' + new Date(1000*channel.topic.last_set).toISOString().substring(0,10) + ')</span>';
		}
		content += '</p>';
	}
	if (channel.purpose && channel.purpose.value) {
		content += '<p><strong>Purpose:</strong> ' + processMessageText(channel.purpose.value, true, usersById, team);
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
			name: author.real_name ? (author.real_name + ' (' + author.name + ')') : author.name,
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
			if (e.code === ErrorCode.PlatformError) {
				if (e.data.error === 'channel_not_found') {
					res.status(404).send('Channel not found: ' + channelid);
					console.log('Channel not found: ' + channelid);
				}
				else {
					res.status(500).send(e.data);
					console.log('PlatformError building channel.xml?id=' + channelid + ':', e.data);
				}
			}
			else {
				res.status(500).send(e.toString() + '\n' + e.stack);
				console.log('Error building channel.xml?id=' + channelid + ':', e);
			}
		});
	}
});

app.listen(config.port, () => {
	console.log('listening on port ' + config.port);
});
