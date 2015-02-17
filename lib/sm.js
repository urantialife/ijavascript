#!/usr/bin/env node

/*
 * BSD 3-Clause License
 *
 * Copyright (c) 2015, Nicolas Riesco and others as credited in the AUTHORS file
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 * this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation
 * and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 * may be used to endorse or promote products derived from this software without
 * specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 *
 */

/** @module sm
 *
 * @description Module `sm` provides a Javascript session manager. A Javascript
 * session can be used to run Javascript code within `node.js`, pass the result
 * to a callback function and even capture its `stdout` and `stderr` streams.
 *
 * @example Example of usage:
 *
 *  // Initiate a session manager
 *  var sm = new Manager();
 *
 *  // Callback called before running the Javascript code.
 *  var beforeRun = function (session) {
 *      session.executionCount++;
 *  };
 *  // Callback called after running the Javascript code.
 *  var afterRun = function (session) {
 *      console.log(session.executionCount);
 *  };
 *  // Callback called only if no errors occurred.
 *  var onSuccess = function (session) {
 *      console.log(session.result.mime["text/plain"]);
 *  };
 *  // Callback called only if errors occurred.
 *  var onError = function (session) {
 *      console.log(session.result.error.traceback]);
 *  };
 *
 *  // Session "session 1"
 *  // Output:
 *  // undefined
 *  // 1
 *  // `Hello, World!`
 *  // 2
 *  var session = "session 1";
 *  var code    = "var msg=`Hello, World!`;";
 *  sm.run(session, code, beforeRun, afterRun, onSuccess, onError);
 *
 *  code    = "msg;";
 *  sm.run(session, code, beforeRun, afterRun, onSuccess, onError);
 *
 *  // Session "session 2"
 *  // Output:
 *  // ReferenceError: msg is not defined
 *  //     at evalmachine.<anonymous>:1:1
 *  //     at onMessage ([eval]:47:28)
 *  //     at process.EventEmitter.emit (events.js:98:17)
 *  //     at handleMessage (child_process.js:318:10)
 *  //     at Pipe.channel.onread (child_process.js:345:11)
 *  // 1
 *  session = "session 2";
 *  sm.run(session, code, beforeRun, afterRun, onSuccess, onError);
 *
 */
module.exports.Manager = Manager;
module.exports.Session = Session;

var DEBUG = false;

var spawn = require("child_process").spawn;
var fs = require("fs");
var path = require("path");

// File paths
var paths = {
    node: process.argv[0],
    thisFile: fs.realpathSync(process.argv[1]),
};
paths.thisFolder = path.dirname(paths.thisFile);
paths.client = paths.thisFile;
paths.server = path.join(paths.thisFolder, "sm_server.js");

// Server that runs a code request within a session
var server = {
    command: paths.node,
    args: ["--eval", fs.readFileSync(paths.server)], // --eval workaround
    options: {
        cwd: process.env.HOME || process.env.USERPROFILE,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
    create: function() {
        return spawn(this.command, this.args, this.options);
    }
};

/**
 * @class
 * @classdesc Manages a collection of Javascript sessions
 */
function Manager() {}

/**
 * Run a task within a Javascript session
 *
 * @param {string}         session Session ID
 * @param {module:sm~task} task    Task to be run
 */
Manager.prototype.run = function(session, task) {
    if (!this.hasOwnProperty(session)) {
        this[session] = new Session();
    }

    this[session].run(task);
};

/**
 * @class
 * @classdesc Implements a Javascript session
 */
function Session() {
    /**
     * Server that runs the code requests for this session
     * @member {module:child_process~ChildProcess}
     * @private
     */
    this._server = server.create();

    /**
     * Task currently being run (`null` if none)
     * @member {?module:sm~task}
     * @private
     */
    this._task = null;

    /**
     * Queue of tasks to be run
     * @member {module:sm~task[]}
     * @private
     */
    this._tasks = [];

    /**
     * Number of execution requests
     * @member {number}
     */
    this.executionCount = 0;

    /**
     * Last result
     * @member {module:sm~result}
     */
    this.result = undefined;

    // Setup server for this session
    this._server.on("message", Session.prototype._onMessage.bind(this));
}

/**
 * Combination of a piece of code to be run within a session and all the
 * associated callbacks.
 *
 * @typedef task
 *
 * @property {string}              action      Type of task:
 *                                             "run" to evaluate a piece of code
 *                                             and return the result;
 *                                             "getAllPropertyNames" to evaluate
 *                                             a piece of code and return all
 *                                             the property names of the result;
 * @property {string}              code        Code to evaluate
 * @property {module:sm~sessionCB} [beforeRun] Called before the code
 * @property {module:sm~sessionCB} [afterRun]  Called after the code
 * @property {module:sm~sessionCB} onSuccess   Called if no errors occurred
 * @property {module:sm~sessionCB} onError     Called if an error occurred
 */

/**
 * @callback sessionCB
 * @param {module:sm~Session} session Session
 * @description Session Callback
 */

/**
 * Result of running a piece of code within a session.
 *
 * @typedef result
 *
 * @property {?string}  stdout            Stdout output
 * @property {?string}  stderr            Stderr output
 * @property            [mime]            Defined only for successful "run"
 *                                        actions
 * @property {string}   mime."text/plain" Result in plain text
 * @property {string}   mime."text/html"  Result in HTML format
 * @property            [error]           Defined only for failed "run" actions
 * @property {string}   error.ename       Error name
 * @property {string}   error.evalue      Error value
 * @property {string[]} error.traceback   Error traceback
 * @property {string[]} [names]           Defined only for "getAllPropertyNames"
 *                                        actions. It contains an array with all
 *                                        the property names of the result of
 *                                        evaluating a piece of code.
 */

/**
 * Callback to handle messages from the session server
 *
 * @param {module:sm~result} message Result of last execution request
 * @private
 */
Session.prototype._onMessage = function(message) {
    if (DEBUG) console.log("VM: _onMessage", message);

    var stdout = this._server.stdout.read();
    var stderr = this._server.stderr.read();

    this.result = message;
    this.result.stdout = (stdout === null) ? null : stdout.toString();
    this.result.stderr = (stderr === null) ? null : stderr.toString();

    if (message.hasOwnProperty("error")) {
        this._task.onError(this);
    } else {
        this._task.onSuccess(this);
    }

    if (this._task.afterRun) {
        this._task.afterRun(this);
    }

    // Are there any tasks left on the queue?
    if (this._tasks.length > 0) {
        this._runNow(this.tasks.pop());
    } else {
        this._task = null;
    }
};

/**
 * Run a task
 *
 * @param {module:sm~task} task Task to be run
 */
Session.prototype.run = function(task) {
    if (DEBUG) console.log("VM: run:", task);
    if (this._task === null) {
        this._runNow(task);
    } else {
        this._runLater(task);
    }
};

/**
 * Run a task now
 *
 * @param {module:sm~task} task Task to be run
 * @private
 */
Session.prototype._runNow = function(task) {
    this._task = task;
    if (this._task.beforeRun) {
        this._task.beforeRun(this);
    }

    this._server.send([this._task.action, this._task.code]);
};

/**
 * Run a task later
 *
 * @param {module:sm~task} task Task to be run
 * @private
 */
Session.prototype._runLater = function(task) {
    this._tasks.push(task);
};