var http = require('http'),
	url = require('url'),
	geoip = require('geoip-lite'),
	moment = require('moment'),
	time = require('time'),
	crypto = require('crypto'),
	mongo = require('mongoskin'),
	countlyConfig = require('./config'), // Config file for the app
	port = countlyConfig.api.port,
	countlyDb = mongo.db(countlyConfig.mongodb.host + ':' + countlyConfig.mongodb.port + '/' + countlyConfig.mongodb.db + '?auto_reconnect');

// Global date variables
var now, timestamp, yearly, monthly, weekly, daily, hourly, appTimezone;

// Countly mongodb collections use short key names.
// This map is used to transform long key names to shorter ones.
var dbMap = {
	'events': 'e',
	'total': 't',
	'new': 'n',
	'unique': 'u',
	'duration': 'd',
	'durations': 'ds',
	'frequency': 'f',
	'loyalty': 'l'
};

// Checks app_key from the http request against "apps" collection. This is the first step of every write request to API.
function validateAppForWriteAPI(getParams) {
	countlyDb.collection('apps').findOne({'key': getParams.app_key}, function(err, app){
		if (!app) {
			return false;
		}
		
		var tmpTimestamp,
			intRegex = /^\d+$/;
		
		// Check if the timestamp paramter exists in the request and is an 10 digit integer
		if (getParams.timestamp && getParams.timestamp.length == 10 && intRegex.test(getParams.timestamp)) {
			tmpTimestamp = getParams.timestamp;
		}

		// Set the timestamp to request parameter value or the current time
		timestamp = (tmpTimestamp)? tmpTimestamp : time.time();

		// Construct the a date object from the received timestamp or current time
		now = (tmpTimestamp)? new time.Date(tmpTimestamp * 1000) : new time.Date();
		appTimezone = app.timezone;
		now.setTimezone(appTimezone);
		
		yearly = now.getFullYear();
		monthly = yearly + '.' + (now.getMonth() + 1);
		daily = monthly + '.' + (now.getDate());
		hourly = daily + '.' + (now.getHours());
		weekly = Math.ceil(moment(now.getTime()).format("DDD") / 7);
		
		getParams.app_id = app['_id'];
		var updateSessions = {};
		fillTimeObject(updateSessions, dbMap['events']);
		countlyDb.collection('sessions').update({'_id': getParams.app_id}, {'$inc': updateSessions}, {'upsert': true});
		
		checkUserLocation(getParams);
	});
}

function validateAppForReadAPI(getParams, callback, collection, res) {
	countlyDb.collection('apps').findOne({'key': getParams.app_key}, function(err, app){
		if (!app) {
			res.end();
			return false;
		}
		getParams.app_id = app['_id'];
		callback(getParams, collection, res);
	});
}

// Creates a time object in the format object["2012.7.20.property"] = increment.
function fillTimeObject(object, property, increment) {
	var increment = (increment)? increment : 1;
	
	object[yearly + '.' + property] = increment;
	object[monthly + '.' + property] = increment;
	object[daily + '.' + property] = increment;
	
	// If the property parameter contains a dot, hourly data is not saved in 
	// order to prevent two level data (such as 2012.7.20.TR.u) to get out of control. 
	if (property.indexOf('.') == -1) {
		object[hourly + '.' + property] = increment;
	}
	
	// For properties that hold the unique visitor count we store weekly data as well.
	if (property.substr(-2) == ("." + dbMap["unique"]) || 
		property == dbMap["unique"] ||
		property.substr(0,2) == (dbMap["frequency"] + ".") ||
		property.substr(0,2) == (dbMap["loyalty"] + "."))
	{
		object["w" + weekly + '.' + property] = increment;
	}
}

function checkUserLocation(getParams) {
	// Location of the user is retrieved using geoip-lite module from her IP address.
	var locationData = geoip.lookup(getParams.ip_address);

	if (locationData) {
		if (locationData.country) {
			getParams.user.country = locationData.country;
		}
		
		// City and coordinate values of the user location has no use for now but 
		// here they are in case you need them.
		if (locationData.city) {
			getParams.user.city = locationData.city;
		}
		if (locationData.ll) {
			getParams.user.lat = locationData.ll[0];
			getParams.user.lng = locationData.ll[1];
		}
	}
	
	processUserLocation(getParams);
}

function processUserLocation(getParams) {	
	// If begin_session exists in the API request
	if (getParams.is_begin_session) {
		// Before processing the session of the user we check if she exists in app_users collection.
		countlyDb.collection('app_users').findOne({'_id': getParams.app_user_id }, function(err, dbAppUser){
			processUserSession(dbAppUser, getParams);
		});
	} else if (getParams.is_end_session) { // If end_session exists in the API request
		if (getParams.session_duration) {
			processSessionDuration(getParams);
		}
		countlyDb.collection('app_users').findOne({'_id': getParams.app_user_id }, function(err, dbAppUser){
			// If the user does not exist in the app_users collection or she does not have any 
			// previous session duration stored than we dont need to calculate the session 
			// duration range for this user.
			if (!dbAppUser || !dbAppUser['session_duration']) {
				return false;
			}
			
			processSessionDurationRange(getParams, dbAppUser['session_duration']);
		});
	} else {
	
		// If the API request is not for begin_session or end_session it has to be for 
		// session duration calculation.
		if (getParams.session_duration) {
			processSessionDuration(getParams);
		}
	}
}

function getUserMetrics(getParams) {
	var tmp_metrics = {},
		allowed_user_metrics = ['_os', '_os_version', '_device', '_resolution', '_carrier', '_app_version'];
	
	for (var metric in getParams.metrics) {
		if (allowed_user_metrics.indexOf(metric) !== -1) {
			tmp_metrics[metric] = getParams.metrics[metric];
		}
	}
	
	return tmp_metrics;
}

function processSessionDurationRange(getParams, totalSessionDuration) {
	var durationRanges = [
			[0,10],
			[11,30],
			[31,60],
			[61,180],
			[181,600],
			[601,1800],
			[1801,3600]
		],
		durationMax = 3601,
		calculatedDurationRange,
		updateSessions = {};
		
		if (totalSessionDuration >= durationMax) {
			calculatedDurationRange = (durationRanges.length) + '';
		} else {
			for (var i=0; i < durationRanges.length; i++) {
				if (totalSessionDuration <= durationRanges[i][1] && totalSessionDuration >= durationRanges[i][0]) {
					calculatedDurationRange = i + '';
					break;
				}
			}
		}
		
		fillTimeObject(updateSessions, dbMap['durations'] + '.' + calculatedDurationRange);
		countlyDb.collection('sessions').update({'_id': getParams.app_id}, {'$inc': updateSessions, '$addToSet': {'d-ranges': calculatedDurationRange}}, {'upsert': false});
		countlyDb.collection('app_users').update({'_id': getParams.app_user_id}, {'$set': {'session_duration': 0, 'app_id': getParams.app_id}}, {'upsert': true});
}

function processSessionDuration(getParams) {
	var updateSessions = {},
		session_duration = parseInt(getParams.session_duration);
	
	if (session_duration == (session_duration | 0)) {
		fillTimeObject(updateSessions, dbMap['duration'], session_duration);
	
		countlyDb.collection('sessions').update({'_id': getParams.app_id}, {'$inc': updateSessions}, {'upsert': false});
		countlyDb.collection('app_users').update({'_id': getParams.app_user_id}, {'$inc': {'session_duration': session_duration, '$set': { 'app_id': getParams.app_id }}}, {'upsert': true});
	}
}

function processUserSession(dbAppUser, getParams) {
	var updateSessions = {},
		updateUsers = {},
		updateLocations = {},
		userRanges = {},
		loyaltyRanges = [
			[0,1],
			[2,2],
			[3,5],
			[6,9],
			[10,19],
			[20,49],
			[50,99],
			[100,499]
		],
		sessionFrequency = [
			[0,1],
			[1,24],
			[24,48],
			[48,72],
			[72,96],
			[96,120],
			[120,144],
			[144,168],
			[168,192],
			[192,360],
			[360,744]
		],
		sessionFrequencyMax = 744,
		calculatedFrequency,
		loyaltyMax = 500,
		calculatedLoyaltyRange,
		uniqueLevels = [],
		isNewUser = false;
	
	fillTimeObject(updateSessions, dbMap['total']);
	fillTimeObject(updateLocations, getParams.user.country + '.' + dbMap['total']);
	
	if (dbAppUser) {
		if ((timestamp - dbAppUser.last_seen) >= (sessionFrequencyMax * 60 * 60)) {
			calculatedFrequency = sessionFrequency.length + '';
		} else {
			for (var i=0; i < sessionFrequency.length; i++) {
				if ((timestamp - dbAppUser.last_seen) < (sessionFrequency[i][1] * 60 * 60) && 
					(timestamp - dbAppUser.last_seen) >= (sessionFrequency[i][0] * 60 * 60)) {
					calculatedFrequency = i + '';
					break;
				}
			}
		}
		
		var userSessionCount = dbAppUser.session_count + 1;

		//Calculate the loyalty range of the user
		if (userSessionCount >= loyaltyMax) {
			calculatedLoyaltyRange = loyaltyRanges.length + '';
		} else {
			for (var i=0; i < loyaltyRanges.length; i++) {
				if (userSessionCount <= loyaltyRanges[i][1] && userSessionCount >= loyaltyRanges[i][0]) {
					calculatedLoyaltyRange = i + '';
					break;
				}
			}
		}
		
		var secInMin = (60 * (now.getMinutes())) + now.getSeconds(),
			secInHour = (60 * 60 * (now.getHours())) + secInMin,
			secInMonth = (60 * 60 * 24 * (now.getDate() - 1)) + secInHour;
			
		var currentTime = new time.Date(dbAppUser.last_seen * 1000);
		currentTime.setTimezone(appTimezone);
		
		var userLastSessionWeek = Math.ceil(moment(currentTime.getTime()).format("DDD") / 7);
		
		if (userLastSessionWeek < weekly) {
			uniqueLevels[uniqueLevels.length] = "w" + weekly;
		}
		if (dbAppUser.last_seen <= (timestamp - secInMin)) {
			uniqueLevels[uniqueLevels.length] = hourly;
		}
		if (dbAppUser.last_seen <= (timestamp - secInHour)) {
			uniqueLevels[uniqueLevels.length] = daily;
		}
		if (dbAppUser.last_seen <= (timestamp - secInMonth)) {
			uniqueLevels[uniqueLevels.length] = monthly;
		}
		if (dbAppUser.last_seen < (timestamp - secInMonth)) {
			uniqueLevels[uniqueLevels.length] = yearly;
		}

		for (var i=0; i < uniqueLevels.length; i++) {
			updateSessions[uniqueLevels[i] + '.' + dbMap['unique']] = 1;
			updateLocations[uniqueLevels[i] + '.' + getParams.user.country + '.' + dbMap['unique']] = 1;
			updateUsers[uniqueLevels[i] + '.' + dbMap['frequency'] + '.' + calculatedFrequency] = 1;
			updateUsers[uniqueLevels[i] + '.' + dbMap['loyalty'] + '.' + calculatedLoyaltyRange] = 1;
		}
		
		if (uniqueLevels.length != 0) {
			userRanges['f-ranges'] = calculatedFrequency;
			userRanges['l-ranges'] = calculatedLoyaltyRange;
			countlyDb.collection('users').update({'_id': getParams.app_id}, {'$inc': updateUsers, '$addToSet': userRanges}, {'upsert': true});
		}
		
	} else {
		isNewUser = true;
		
		// User is not found in app_users collection so this means she is both a new and unique user.
		fillTimeObject(updateSessions, dbMap['new']);
		fillTimeObject(updateSessions, dbMap['unique']);
		fillTimeObject(updateLocations, getParams.user.country + '.' + dbMap['new']);
		fillTimeObject(updateLocations, getParams.user.country + '.' + dbMap['unique']);
		
		// First time user.
		calculatedLoyaltyRange = '0';
		calculatedFrequency = '0';
		
		fillTimeObject(updateUsers, dbMap['frequency'] + '.' + calculatedFrequency);
		userRanges['f-ranges'] = calculatedFrequency;
		
		fillTimeObject(updateUsers, dbMap['loyalty'] + '.' + calculatedLoyaltyRange);
		userRanges['l-ranges'] = calculatedLoyaltyRange;
		
		countlyDb.collection('users').update({'_id': getParams.app_id}, {'$inc': updateUsers, '$addToSet': userRanges}, {'upsert': true});
	}
	
	countlyDb.collection('sessions').update({'_id': getParams.app_id}, {'$inc': updateSessions}, {'upsert': true});
	countlyDb.collection('locations').update({'_id': getParams.app_id}, {'$inc': updateLocations, '$addToSet': {'countries': getParams.user.country }}, {'upsert': true});
	countlyDb.collection('app_users').update({'_id': getParams.app_user_id}, {'$inc': {'session_count': 1}, '$set': { 'last_seen': timestamp, 'app_id': getParams.app_id }}, {'upsert': true});
	
	processPredefinedMetrics(getParams, isNewUser, uniqueLevels);
}

function processPredefinedMetrics(getParams, isNewUser, uniqueLevels) {
	if (!getParams.metrics) {
		return false;
	}
	
	var predefinedMetrics = [
		{ db: "devices", metrics: [{ name: "_device", set: "devices" }] },
		{ db: "carriers", metrics: [{ name: "_carrier", set: "carriers" }] },
		{ db: "device_details", metrics: [{ name: "_os", set: "os" }, { name: "_os_version", set: "os_versions" }, { name: "_resolution", set: "resolutions" }] },
		{ db: "app_versions", metrics: [{ name: "_app_version", set: "app_versions" }] }
	];
	
	for (var i=0; i < predefinedMetrics.length; i++) {
		var tmpTimeObj = {},
			tmpSet = {},
			needsUpdate = false;
	
		for (var j=0; j < predefinedMetrics[i].metrics.length; j++) {
			var tmpMetric = predefinedMetrics[i].metrics[j],
				recvMetricValue = getParams.metrics[tmpMetric.name];
				
			if (recvMetricValue) {
				var escapedMetricVal = recvMetricValue.replace(/([.$])/mg, ":");
				needsUpdate = true;
				tmpSet[tmpMetric.set] = escapedMetricVal;
				fillTimeObject(tmpTimeObj, escapedMetricVal + '.' + dbMap['total']);
				
				if (isNewUser) {
					fillTimeObject(tmpTimeObj, escapedMetricVal + '.' + dbMap['new']);
					fillTimeObject(tmpTimeObj, escapedMetricVal + '.' + dbMap['unique']);
				} else {
					for (var k=0; k < uniqueLevels.length; k++) {
						tmpTimeObj[uniqueLevels[k] + '.' + escapedMetricVal + '.' + dbMap['unique']] = 1;
					}
				}
			}
		}
		
		if (needsUpdate) {
			countlyDb.collection(predefinedMetrics[i].db).update({'_id': getParams.app_id}, {'$inc': tmpTimeObj, '$addToSet': tmpSet}, {'upsert': true});
		}
	}
}

var fetchTimeData = function(getParams, collection, res) {
	countlyDb.collection(collection).findOne({'_id' : getParams.app_id}, function(err, result){
		
		if (!result) {
			now = new time.Date();
			result = {};
			result[now.getFullYear()] = {};
		}
				
		if (getParams.callback) {
			result = getParams.callback + "(" + JSON.stringify(result) + ")";
		} else {
			result = JSON.stringify(result);
		}
				
		res.writeHead(200, {'Content-Type': 'application/json'});
		res.write(result);
		res.end();
	});
}

http.Server(function(req, res) {
	var urlParts = url.parse(req.url, true);
	
	switch(urlParts.pathname) {
	
		case '/i':
			var	queryString = urlParts.query;
			var getParams = {
					'app_id': '',
					'app_key': queryString.app_key,
					'ip_address': req.headers['x-forwarded-for'] || req.connection.remoteAddress,
					'sdk_version': queryString.sdk_version,
					'device_id': queryString.device_id,
					'metrics': queryString.metrics,
					'session_duration': queryString.session_duration,
					'session_duration_total': queryString.session_duration_total,
					'is_begin_session': queryString.begin_session,
					'is_end_session': queryString.end_session,
					'user' : {
						'last_seen': 0, 
						'duration': 0,
						'country': 'Unknown'
					},
					'timestamp': queryString.timestamp
				};
			
			if (!getParams.app_key || !getParams.device_id) {
				res.writeHead(400);
				res.end();
				return false;
			} else {
				// Set app_user_id that is unique for each user of an application.
				getParams.app_user_id = crypto.createHash('sha1').update(getParams.app_key + getParams.device_id + "").digest('hex');
			}
			
			if (getParams.metrics) {
				try {
					getParams.metrics = JSON.parse(getParams.metrics);

					if (getParams.metrics["_carrier"]) {
						getParams.metrics["_carrier"] = getParams.metrics["_carrier"].replace(/\w\S*/g, function(txt){return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();});
					}
					
					if (getParams.metrics["_os"] && getParams.metrics["_os_version"]) {
						getParams.metrics["_os_version"] = getParams.metrics["_os"][0].toLowerCase() + getParams.metrics["_os_version"];
					}
					
				} catch (SyntaxError) { console.log('Parse metrics JSON failed') }
			}
			
			validateAppForWriteAPI(getParams);
			
			res.writeHead(200);
			res.end();
	
			break;
		case '/o':
			var	queryString = urlParts.query;
			var getParams = {
					'app_key': queryString.app_key,
					'method': queryString.method,
					'callback': queryString.callback
				};
				
			if (!getParams.app_key) {
				res.writeHead(400);
				res.end();
				return false;
			}
			
			switch (getParams.method) {
				case 'locations':
				case 'sessions':
				case 'users':
				case 'devices':
				case 'device_details':
				case 'carriers':
				case 'app_versions':
					validateAppForReadAPI(getParams, fetchTimeData, getParams.method, res);
					break;
				default:
					res.writeHead(400);
					res.end();
					break;
			}

			break;
		default:
			res.writeHead(400);
			res.end();
			break;
	}
}).listen(port);
