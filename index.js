/**
 * @file web.js
 * @author Ken Eucker <keneucker@gmail.com>
 */

const express = require('express'),
	path = require('path'),
	quasarSDK = require('@digitaltrends/quasar'),
	os = require('os'),
	fs = require('fs'),
	mkdir = require('mkdirp-sync'),
	yargs = require('yargs'),
	bodyParser = require('body-parser'),
	jsonPromise = require('express-json-promise');

/**
 * @classdesc The web application for running the quasar API and webform.
 * @export`
 * @hideconstructor
 * @class QuasarWebApi
 */
class QuasarWebApi {
	constructor() {
		if (!yargs.argv['noLogo'] || yargs.argv['noLogo'] == false) {
			const packageJson = require('./package.json');
			quasarSDK.logQuasarLogo('QuasarWebApi', packageJson, 'green');
		}

		/** @type {string} */
		this.port = process.env.port || '3000';
		/** @type {express} */
		this._app = null;
		/** @type {string} */
		this.jobsCreatedDirectory = path.resolve(`${quasarSDK.config.jobsFolder}/${quasarSDK.STATUS_CREATED}`);
		/** @type {string} */
		this.sourcesDirectory = quasarSDK.config.sourcesFolder;
		/** @type {array} */
		this.availableTasks = quasarSDK.getTaskNames();
		/** @type {bool} */
		this.runWebApiStandalone = yargs.argv.runWebApiStandalone;

		if (this.runWebApiStandalone) {
			quasarSDK.debug(`will run the api standalone on port [${yargs.argv.apiPort}]`);
			this.run(null, yargs.argv.apiPort, true);
		}
	}

	/**
	 * @description retrieves the express instance for the web app
	 * @readonly
	 * @memberof QuasarWebApi
	 * @returns {express}
	 */
	get app() {
		return this._app;
	}

	/**
	 * @description the content for a loading page with a message
	 * @param {string} [message=`Loading ...`]
	 * @returns {string}
	 * @memberof QuasarWebApi
	 */
	autoReloadingPageWithMessage(message = `Loading ...`) {
		return `
			<html>
				<body>
					<h1>
						${message}
					</h1>

					<script>
					setInterval(function() {
						var h1 = document.querySelector('h1');
						if(h1) {
							h1.innerHTML += '.';
						}
					}, 300)
					setInterval(function() {
						window.location.reload(true);
					}, 1200)
					</script>
				</body>
			</html>
		`;
	}

	/**
	 * @description Writes a jobFile to the jobs folder
	 * @param {QuasArgs} args the args to create the job with
	 * @returns {promise} resolves with the created job information
	 * @memberof QuasarWebApi
	 */
	createJobFile(args, destination = 'local') {
		quasarSDK.debug('createJobFile', destination);
		return new Promise((resolve, reject) => {
			let jobId = `${args.qType}_${Date.now()}`,
				jobFile = '';

			switch (destination) {
				case 'local':
					quasarSDK.debug('will save jobFile to local filesystem');
					jobFile = `${this.jobsCreatedDirectory}/${jobId}.json`;

					args = this.saveSourceFiles(args);

					quasarSDK.logInfo(`creating job:(${jobId}) on local filestorage from build arguments received:`, args);
					fs.writeFileSync(jobFile, JSON.stringify(args));
					break;

				case 's3':
					quasarSDK.debug('will save jobFile to AWS S3');
					quasarSDK.logInfo(`creating job:(${jobId}) on local filestorage from build arguments received:`, args);
					break;

				case 'dynamodb':
					quasarSDK.debug('will save job args in AWS DynamoDB');
					quasarSDK.logInfo(`creating job:(${jobId}) on local filestorage from build arguments received:`, args);
					break;

				default:
					quasarSDK.logCritical(`I just can't do it captain, I don't have the power!!`);
					break;
			}

			return resolve({
				args,
				destination,
				status: quasarSDK.STATUS_CREATED,
				id: jobId,
				jobFile,
				jobsDirectory: this.jobsCreatedDirectory,
			});
		});
	}

	/**
	 * @description sends the landing page
	 * @param {*} req
	 * @param {*} res
	 * @memberof QuasarWebApi
	 */
	getLandingPage(req, res) {
		if (req.query.jobId) {
			return getJob(req.query.jobId, res);
		}

		res.send(`Hello, world!`);
	}

	/**
	 * @description sends the outputFile of a job or the json data about the job if it has not completed
	 * @param {*} req
	 * @param {*} res
	 * @memberof QuasarWebApi
	 */
	getJob(jobId, res) {
		const jobData = this.getJobData(jobId);

		switch (jobData.status) {
			default:
				res.send();
				break;

			case `created`:
			case `queued`:
				res.send(this.autoReloadingPageWithMessage(`Job has been ${jobData.status} ...`));
				break;

			case `completed`:
				if (fs.existsSync(jobData.args.outputFilePath)) {
					res.sendFile(jobData.args.outputFilePath);
				} else {
					jobData.error = `outputFilePath not found: ${jobData.args.outputFilePath}`;
					quasarSDK.logInfo(jobData.error);
					res.send(jobData);
				}
				break;
		}
	}

	/**
	 * @description compiles the status and jobfile information with the args for the jobId
	 * @param {number} jobId
	 * @returns {object} jobData
	 * @memberof QuasarWebApi
	 */
	getJobData(jobId) {
		const jobStatus = this.getJobStatus(jobId);
		const jobFilePath = path.resolve(`${quasarSDK.config.jobsFolder}/${jobStatus}/${jobId}.json`);
		const jobData = {
			id: jobId,
			status: jobStatus,
			jobFilePath,
		};

		if (fs.existsSync(jobData.jobFilePath)) {
			const argsFile = fs.readFileSync(jobData.jobFilePath);
			jobData.args = JSON.parse(argsFile);
		}

		return jobData;
	}

	/**
	 * @description returns the status of a job based on the filename and which job folder it is in
	 * @param {*} jobId
	 * @returns {string}
	 * @memberof QuasarWebApi
	 */
	getJobStatus(jobId, source = 'local') {
		const STATUS_COMPLETED = quasarSDK.STATUS_COMPLETED,
			STATUS_CREATED = quasarSDK.STATUS_CREATED,
			STATUS_QUEUED = quasarSDK.STATUS_QUEUED,
			STATUS_FAILED = quasarSDK.STATUS_FAILED;

		switch (source) {
			case 'local':
				const jobFilePath = path.resolve(`${quasarSDK.config.jobsFolder}/${STATUS_COMPLETED}/${jobId}.json`);

				if (fs.existsSync(jobFilePath)) {
					return `${STATUS_COMPLETED}`;
				} else if (fs.existsSync(jobFilePath.replace(`/${STATUS_COMPLETED}`, `/${STATUS_CREATED}`).replace(`\\${STATUS_COMPLETED}`, `\\${STATUS_CREATED}`))) {
					return `${STATUS_CREATED}`;
				} else if (fs.existsSync(jobFilePath.replace(`/${STATUS_COMPLETED}`, `/${STATUS_QUEUED}`).replace(`\\${STATUS_COMPLETED}`, `\\${STATUS_QUEUED}`))) {
					return `${STATUS_QUEUED}`;
				} else if (fs.existsSync(jobFilePath.replace(`/${STATUS_COMPLETED}`, `/${STATUS_FAILED}`).replace(`\\${STATUS_COMPLETED}`, `\\${STATUS_FAILED}`))) {
					return `${STATUS_FAILED}`;
				}
				break;
		}
		return null;
	}

	/**
	 * @description returns the directory view of a domain/signal for a given date range
	 * @param {*} req
	 * @param {*} res
	 * @memberof QuasarWebApi
	 */
	getPublicBuild(req, res) {
		const domain = req.params.domain;
		const signal = req.params.signal;
		const targetFile = req.query.target;
		const targetFilePath = path.resolve(`${quasarSDK.config.assetsFolder}/${domain}/${signal}/${targetFile}`);

		if (fs.existsSync(targetFilePath)) {
			res.sendFile(targetFilePath);
		} else {
			quasarSDK.logInfo(`outputFilePath not found: ${targetFilePath}`);
			res.send({});;
		}

	}

	/**
	 * @description creates a jobfile and returns the preliminary data to the response
	 * @param {*} req
	 * @param {*} res
	 * @returns {promise} the json response to the request
	 * @memberof QuasarWebApi
	 */
	onTaskDataReceived(req, res) {
		const data = req.body;

		return res.json(this.createJobFile(data));
	}

	/**
	 * @description runs the express application with webpage and API
	 * @param {express} [app=null]
	 * @param {number} [port=null]
	 * @param {boolean} [start=false]
	 * @memberof QuasarWebApi
	 */
	run(app = null, port = null, start = false) {
		const self = this;
		if (!app) {
			app = express();
			// lib.debug('will create the app');
			start = true;
		}
		this.port = port || this.port;
		this._app = app;

		/// TODO: Do we still need to do this?? This should  be done by the SDK
		mkdir(this.sourcesDirectory);
		mkdir(this.jobsCreatedDirectory);
		/// REMOVE?

		this._app.use(bodyParser.json({
			limit: '50mb'
		}));
		this._app.use(bodyParser.urlencoded({
			extended: true,
			limit: '50mb'
		}));
		this._app.use(jsonPromise());

		this._app.get('/public/:domain/:signal',
			(req, res) => {
				self.getPublicBuild(req, res);
			});
		this._app.get('/job/:id',
			(req, res) => {
				self.getJob(req.params.id, res);
			});

		if (this.runWebApiStandalone) {
			this._app.get('/',
				(req, res) => {
					self.getLandingPage(req, res);
				});
		}
		this._app.post('/',
			(req, res) => {
				self.onTaskDataReceived(req, res);
			});

		if (start) {
			this._app.listen(this.port);
			quasarSDK.debug('did start the app');
		}

		quasarSDK.logSuccess(`quasar api running on port:${this.port} at http://localhost:${this.port}`);
	}

	/**
	 * @description saves an uploaded source file to the sources folder
	 * @param {QuasArgs} args
	 * @returns {QuasArgs} the saved QuasArgs
	 * @memberof QuasarWebApi
	 */
	saveSourceFiles(args) {
		quasarSDK.debug('will saveSourceFiles');

		const sourcesDirectory = quasarSDK.config.sourcesFolder;
		if (args.source && args.source.length) {
			var sourceFile = args.source;
			const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,4}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/i;
			if (urlRegex.test(sourceFile)) {
				// Let the job handle downloading of source files
			} else {
				let removeUntil = args.source.indexOf(',');
				removeUntil = removeUntil > 0 ? removeUntil + 1 : removeUntil;

				let sourceExt = `.zip`;
				// TODO: WTF THIS HACK?!
				let name = args.source.substr(0, removeUntil - 1).split('name=').pop().split(';');
				let split = name[0].split('.');
				sourceExt = split.length > 1 ? `.${split.pop()}` : sourceExt;
				name = split.join('.');

				const base64 = args.source.substr(removeUntil);
				const sourceFile = `${sourcesDirectory}/${name}`;

				fs.writeFileSync(`${sourceFile}${sourceExt}`, base64, 'base64');
				args.source = name;
				args.sourceExt = sourceExt;
			}
		}

		return args;
	}

	/**
	 * @description sends a response to a client when a job has been completed
	 * @param {*} job
	 * @param {*} jobFile
	 * @returns {promise}
	 * @memberof QuasarWebApi
	 */
	sendJobFileCompleted(job, jobFile) {
		return new Promise((resolve, reject) => {
			while (!(fs.existsSync(jobFile.replace(quasarSDK.STATUS_QUEUED, quasarSDK.STATUS_COMPLETED)))) {

			}
			return resolve({
				status: quasarSDK.STATUS_COMPLETED,
				job,
				jobFile
			});
		});
	}

	/**
	 * @description sends a response to a client when a job has been queued
	 * @param {string} job
	 * @param {string} jobFile
	 * @returns {promise} resolves to the job queued information
	 * @memberof QuasarWebApi
	 */
	sendJobFileQueued(job, jobFile) {
		return new Promise((resolve, reject) => {
			while (!(fs.existsSync(jobFile.replace(quasarSDK.STATUS_CREATED, quasarSDK.STATUS_QUEUED)))) {

			}
			return resolve({
				status: quasarSDK.STATUS_CREATED,
				job,
				jobFile
			});
		});
	}

}

module.exports = new QuasarWebApi();