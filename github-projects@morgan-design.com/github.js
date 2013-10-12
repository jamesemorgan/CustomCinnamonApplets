const Soup = imports.gi.Soup;
const Lang = imports.lang;

const API_ROOT = "https://api.github.com";

/**
 * Simple Object to encapsulate all access and dealings with github
 **/
function GitHub(options){

	this.username		= options.username;	/** Username for GitHub **/
	this.version		= options.version;	/** Version of application, used in API request **/
	this.logger		= options.logger;	/** The Logger **/

	this.user_agent 	= "Cinnamon-GitHub-Explorer/" + this.version; /** User agent passed when making API requests **/

	this.totalFailureCount 	= 0; 		/** Count Number of failures to prevent **/
	this.lastAttemptDateTime= undefined; 	/** The last time we checked GitHub **/

	this.apiLimit		= undefined; 	/** Max number of requests per hour **/
	this.apiLimitRemaining 	= undefined; 	/** Remaining number of requests in hour **/
	this.apiLimitResetTime	= undefined; 	/** The time when the API rate limit is reset -http://en.wikipedia.org/wiki/Unix_time **/

	/** The magic callbacks **/
	this.callbacks = {}

	/** Object repository statistics information **/
	this.repos = {}

	/** Log verbosely **/
	this.logger.debug("GitHub : Setting Username  = " + this.username);
	this.logger.debug("GitHub : Setting UserAgent = " + this.user_agent);
	this.logger.debug("GitHub : Setting Version	  = " + this.version);

	this.hasExceededApiLimit = function(){
		return this.apiLimitRemaining != undefined && this.apiLimitRemaining <= 0;
	}

	this.onFailure = function(onFailure){
		this.callbacks.onFailure = onFailure;
	}

	this.onSuccess = function(onSuccess){
		this.callbacks.onSuccess = onSuccess;
	}

	this.onRepositoryChangedEvent = function(fireRepoChangedEvent){
		this.fireRepoChangedEvent = fireRepoChangedEvent;
	}

	this.minutesUntilNextRefreshWindow = function(){
		let next_reset = new Date(this.apiLimitResetTime * 1000); // Seconds to millis
		let timeDiff = next_reset.getTime() - this.lastAttemptDateTime.getTime();
		let minutes_diff = Math.floor((timeDiff/1000)/60);
		return minutes_diff + 1; // Always plus 1 minute to ensure we have atleast something to countdown
	}

	try {
		this.httpSession = new Soup.SessionAsync();
		this.httpSession.user_agent = this.user_agent;
	} catch(e) {
		throw 'GitHub: Creating SessionAsync failed: ' + e;
	}

	try {
		Soup.Session.prototype.add_feature.call(this.httpSession, new Soup.ProxyResolverDefault());
	} catch(e) {
		throw 'GitHub: Adding ProxyResolverDefault failed: ' + e;
	}
}

GitHub.prototype.loadDataFeed = function(){

	this.lastAttemptDateTime = new Date(); // Update the attempted date

	var feedUrl = API_ROOT+"/users/"+this.username+"/repos";

	let _this = this;

	let request = Soup.Message.new('GET', feedUrl);

	this.httpSession.queue_message(request, function(session, message){
		_this.onHandleFeedResponse(session, message)
	});
}

GitHub.prototype.onHandleFeedResponse = function(session, message) {

	this.apiLimit			= message.response_headers.get_one("X-RateLimit-Limit");
	this.apiLimitRemaining 	= message.response_headers.get_one("X-RateLimit-Remaining");
	this.apiLimitResetTime	= message.response_headers.get_one("X-RateLimit-Reset");

	this.logger.debug("Header [X-RateLimit-Limit]: " + this.apiLimit);
	this.logger.debug("Header [X-RateLimit-Remaining]: " + this.apiLimitRemaining);
	this.logger.debug("Header [X-RateLimit-Reset]: " + this.apiLimitResetTime);

	let status_code = message.status_code;
	this.logger.debug("HTTP Response Status code [" + status_code + "]");

	try {
		var responseJson = this.parseJsonResponse(message);

		// Successful request
		if(status_code === 200){
			this.totalFailureCount = 0;
			this.callbacks.onSuccess(responseJson);

			for (i in responseJson) {

				let repo = responseJson[i];
				var key = repo.id + "-" + repo.name;

				// Check repo already in map
				if(key in this.repos){

					let current_repo = this.repos[key];

					if(current_repo.total_watchers > repo.watchers){
						this.fireRepoChangedEvent({
							type: "Watchers Fallen",
							content: repo.name,
							link_url: "https://github.com/" + this.username+"/"+repo.name+"/watchers"
						});
					}
					else if(current_repo.total_watchers < repo.watchers){
						this.fireRepoChangedEvent({
							type: "Watchers Grown",
							content: repo.name,
							link_url: "https://github.com/" + this.username+"/"+repo.name+"/watchers"
						});
					}

					if(current_repo.total_open_issues > repo.open_issues){
						this.fireRepoChangedEvent({
							type: "Issues Fallen",
							content: repo.name,
							link_url: "https://github.com/" + this.username+"/"+repo.name+"/issues"
						});
					}
					else if(current_repo.total_open_issues < repo.open_issues){
						this.fireRepoChangedEvent({
							type: "Issues Grown",
							content: "",
							link_url: "https://github.com/" + this.username+"/"+repo.name+"/issues"
						});
					}

					if(current_repo.total_forks > repo.forks){
						this.fireRepoChangedEvent({
							type: "Forks Fallen",
							content: repo.name,
							link_url: "https://github.com/" + this.username+"/"+repo.name+"/network"
						});
					}
					else if(current_repo.total_forks < repo.forks){
						this.fireRepoChangedEvent({
							type: "Forks Grown",
							content: repo.name,
							link_url: "https://github.com/" + this.username+"/"+repo.name+"/network"
						});
					}
				}
				else {
					// TODO new repo event
					/**this.fireRepoChangedEvent({
						type: "New Repository Added",
						content: repo.name,
						link_url: "https://github.com/" + this.username+"/"+repo.name
					});**/
				}

				this.repos[key] = {
					repo_id: repo.id,
					repo_name: repo.name,
					total_watchers: repo.watchers,
					total_forks: repo.forks,
					total_open_issues: repo.open_issues
				}

			}
		}
		// Unsuccessful request
		else if(this.notOverFailureCountLimit()){
			this.totalFailureCount++;
			this.callbacks.onFailure(status_code, responseJson.message);
		}

	} catch(e) {
		this.logger.error("Problem with response callback response " + e);
	}
}

// Number of failures allowed
// TODO remove me!
GitHub.prototype.totalFailuresAllowed = 5;

GitHub.prototype.notOverFailureCountLimit = function() {
	return this.totalFailuresAllowed >= this.totalFailureCount;
}

GitHub.prototype.parseJsonResponse = function(request){
	var rawResponseJSON = request.response_body.data;
	return JSON.parse(rawResponseJSON);
}
