"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIXSession = void 0;
const tslib_1 = require("tslib");
const fs_1 = require("fs");
const readline_1 = require("readline");
const node_persist_1 = tslib_1.__importDefault(require("node-persist"));
const events_1 = require("events");
const lodash_throttle_1 = tslib_1.__importDefault(require("lodash.throttle"));
const fixutils_1 = require("../fixutils");
const fixtagnums_1 = require("../resources/fixtagnums");
const sessions = {};
class FIXSession extends events_1.EventEmitter {
    constructor(fixClient, isAcceptor, options) {
        super();
        this.#session = {
            'incomingSeqNum': 1,
            'outgoingSeqNum': 1,
        };
        this.#saveSession = lodash_throttle_1.default(() => node_persist_1.default.setItemSync(this.#key, this.#session), 100);
        this.#timeOfLastIncoming = new Date().getTime();
        this.#timeOfLastOutgoing = new Date().getTime();
        this.#timeOfLastOutgoingHeartbeat = new Date().getTime();
        this.#testRequestID = 1;
        this.#isResendRequested = false;
        this.#isLogoutRequested = false;
        this.decode = (raw) => {
            this.#timeOfLastIncoming = new Date().getTime();
            const fix = fixutils_1.convertToMap(raw);
            const msgType = fix[fixtagnums_1.keyvals.MsgType];
            if (!this.#session.isLoggedIn && (msgType !== 'A' && msgType !== '5')) {
                const error = '[ERROR] First message must be logon:' + raw;
                throw new Error(error);
            }
            else if (!this.#session.isLoggedIn && msgType === 'A') {
                if (this.#isAcceptor) {
                    this.#fixVersion = fix[fixtagnums_1.keyvals.BeginString];
                    this.#senderCompID = fix[fixtagnums_1.keyvals.TargetCompID];
                    this.#senderSubID = fix[fixtagnums_1.keyvals.SenderSubID];
                    this.#targetCompID = fix[fixtagnums_1.keyvals.SenderCompID];
                    this.#targetSubID = fix[fixtagnums_1.keyvals.TargetSubID];
                    if (this.#isDuplicateFunc(this.#senderCompID, this.#targetCompID)) {
                        const error = `[ERROR] Session already logged in: ${raw} `;
                        throw new Error(error);
                    }
                    if (!this.#isAuthenticFunc(fix, this.#fixClient.connection?.remoteAddress)) {
                        const error = `[ERROR] Session not authentic: ${raw} `;
                        throw new Error(error);
                    }
                    this.createsessionStorage(this.#senderCompID, this.#targetCompID);
                    if (this.#resetSeqNumOnReconect) {
                        this.#session = {
                            incomingSeqNum: 1,
                            outgoingSeqNum: 1
                        };
                    }
                    else {
                        this.#session = this.#retriveSession(this.#senderCompID, this.#targetCompID);
                    }
                }
                const heartbeatInMilliSeconds = parseInt(fix[fixtagnums_1.keyvals.HeartBtInt] ?? this.#defaultHeartbeatSeconds, 10) * 1000;
                this.#heartbeatIntervalID = setInterval(() => {
                    const currentTime = new Date().getTime();
                    if (currentTime - this.#timeOfLastOutgoingHeartbeat > heartbeatInMilliSeconds && this.#sendHeartbeats) {
                        this.send({
                            [fixtagnums_1.keyvals.MsgType]: '0'
                        });
                        this.#timeOfLastOutgoingHeartbeat = new Date().getTime();
                    }
                    if (currentTime - this.#timeOfLastIncoming > (heartbeatInMilliSeconds * 1.5) && this.#expectHeartbeats) {
                        this.send({
                            [fixtagnums_1.keyvals.MsgType]: '1',
                            [fixtagnums_1.keyvals.TestReqID]: this.#testRequestID++
                        });
                    }
                    if (currentTime - this.#timeOfLastIncoming > heartbeatInMilliSeconds * 2 && this.#expectHeartbeats) {
                        const error = this.#targetCompID + `[ERROR] No heartbeat from counter party in milliseconds ${(heartbeatInMilliSeconds * 1.5)} `;
                        this.#fixClient.connection?.emit('error', error);
                    }
                }, heartbeatInMilliSeconds / 2);
                this.#fixClient.connection?.on('close', () => {
                    clearInterval(this.#heartbeatIntervalID);
                });
                this.#session.isLoggedIn = true;
                this.emit('logon', this.#targetCompID);
                if (this.#isAcceptor && this.#respondToLogon) {
                    this.send(fix);
                }
            }
            const msgSeqNum = Number(fix[fixtagnums_1.keyvals.MsgSeqNum]);
            if (msgType !== '4' && msgType !== '5' && fix[fixtagnums_1.keyvals.PossDupFlag] !== 'Y') {
                if (msgSeqNum >= this.#requestResendTargetSeqNum) {
                    this.#isResendRequested = false;
                }
                if (msgSeqNum < this.#session.incomingSeqNum && !this.#isResendRequested) {
                    const error = `[ERROR] Incoming sequence number[${msgSeqNum}]lower than expected[${this.#session.incomingSeqNum}]`;
                    this.logoff(error);
                    throw new Error(error + ' : ' + raw);
                }
                else if (msgSeqNum > this.#session.incomingSeqNum && (this.#requestResendTargetSeqNum == 0 || this.#requestResendRequestedSeqNum !== this.#requestResendTargetSeqNum)) {
                    this.requestResend(this.#session.incomingSeqNum, msgSeqNum);
                }
            }
            if (msgType !== '4' && (msgSeqNum === this.#session.incomingSeqNum || this.#isResendRequested)) {
                this.#session.incomingSeqNum = msgSeqNum + 1;
            }
            switch (msgType) {
                case '1':
                    this.send({
                        [fixtagnums_1.keyvals.MsgType]: '0',
                        [fixtagnums_1.keyvals.TestReqID]: fix[fixtagnums_1.keyvals.TestReqID],
                    });
                    break;
                case '2':
                    this.resendMessages(fix[fixtagnums_1.keyvals.BeginSeqNo] ? Number(fix[fixtagnums_1.keyvals.BeginSeqNo]) : undefined, fix[fixtagnums_1.keyvals.EndSeqNo] ? Number(fix[fixtagnums_1.keyvals.EndSeqNo]) : undefined);
                    break;
                case '4':
                    const resetSeqNo = Number(fix[fixtagnums_1.keyvals.NewSeqNo]);
                    if (resetSeqNo !== NaN) {
                        if (resetSeqNo >= this.#session.incomingSeqNum) {
                            if (resetSeqNo > this.#requestResendTargetSeqNum && this.#requestResendRequestedSeqNum !== this.#requestResendTargetSeqNum) {
                                this.#session.incomingSeqNum = this.#requestResendRequestedSeqNum + 1;
                                this.#isResendRequested = false;
                                this.requestResend(this.#session.incomingSeqNum, this.#requestResendTargetSeqNum);
                            }
                            else {
                                this.#session.incomingSeqNum = resetSeqNo;
                            }
                        }
                        else {
                            const error = '[ERROR] Seq-reset may not decrement sequence numbers';
                        }
                    }
                    else {
                        const error = '[ERROR] Seq-reset has invalid sequence numbers';
                        this.logoff(error);
                        throw new Error(error + ' : ' + raw);
                    }
                    break;
                case '5':
                    if (!this.#isLogoutRequested) {
                        this.send(fix);
                        if (fix[fixtagnums_1.keyvals.NextExpectedMsgSeqNum])
                            this.#session.outgoingSeqNum = Number(fix[fixtagnums_1.keyvals.NextExpectedMsgSeqNum]);
                    }
                    setImmediate(() => {
                        this.#fixClient.connection?.destroy();
                    });
                    this.#session.isLoggedIn = false;
                    this.emit('logoff', {
                        senderCompID: this.#senderCompID,
                        targetCompID: this.#targetCompID,
                        logoffReason: fix[fixtagnums_1.keyvals.Text],
                    });
                    break;
            }
            this.#saveSession();
            return fix;
        };
        this.resetFIXSession = (newSession = {}) => {
            this.#session = this.#retriveSession(this.#senderCompID, this.#targetCompID);
            if (newSession.incomingSeqNum) {
                this.#session.incomingSeqNum = newSession.incomingSeqNum;
            }
            this.#session.isLoggedIn = false;
            try {
                if (newSession.outgoingSeqNum) {
                    this.#session.outgoingSeqNum = newSession.outgoingSeqNum;
                    fs_1.unlinkSync(this.#logfilename);
                }
            }
            catch {
            }
            this.#saveSession();
        };
        this.logon = (logonmsg = {
            [fixtagnums_1.keyvals.MsgType]: 'A',
            [fixtagnums_1.keyvals.EncryptMethod]: '0',
            [fixtagnums_1.keyvals.HeartBtInt]: '10',
        }) => {
            if (this.#resetSeqNumOnReconect) {
                this.#session = {
                    incomingSeqNum: 1,
                    outgoingSeqNum: 1,
                };
            }
            else {
                this.#session = this.#retriveSession(this.#senderCompID, this.#targetCompID);
            }
            this.send(logonmsg);
        };
        this.logoff = (logoffReason = 'Graceful close') => {
            this.send({
                [fixtagnums_1.keyvals.MsgType]: 5,
                [fixtagnums_1.keyvals.Text]: logoffReason,
                [fixtagnums_1.keyvals.NextExpectedMsgSeqNum]: this.#session.incomingSeqNum,
            });
            this.#session.isLoggedIn = false;
            this.#isLogoutRequested = true;
        };
        this.send = (immutableMsg, replay) => {
            const msg = { ...immutableMsg };
            if (!replay) {
                msg[fixtagnums_1.keyvals.LastMsgSeqNumProcessed] = this.#session.incomingSeqNum - 1;
            }
            const outgoingSeqNum = replay ? msg[fixtagnums_1.keyvals.MsgSeqNum] : this.#session.outgoingSeqNum;
            const outmsg = fixutils_1.convertToFIX(msg, this.#fixVersion, fixutils_1.getUTCTimeStamp(), this.#senderCompID, this.#targetCompID, outgoingSeqNum, {
                senderSubID: this.#senderSubID,
                targetSubID: this.#targetSubID,
                senderLocationID: this.#senderLocationID,
                appVerID: this.#appVerID
            });
            this.emit('dataOut', msg);
            this.emit('fixOut', outmsg);
            this.#fixClient.connection?.write(outmsg);
            if (!replay) {
                this.#timeOfLastOutgoing = new Date().getTime();
                this.#session.outgoingSeqNum++;
                this.logToFile(outmsg);
                this.#saveSession();
            }
        };
        this.#file = null;
        this.logToFile = (raw) => {
            if (this.#file === null) {
                this.#logfilename = this.#logFolder + '/' + this.#key + '.log';
                try {
                    fs_1.mkdirSync(this.#logFolder);
                }
                catch {
                }
                try {
                    if (this.#resetSeqNumOnReconect) {
                        fs_1.unlinkSync(this.#logfilename);
                    }
                }
                catch {
                }
                this.#file = fs_1.createWriteStream(this.#logfilename, {
                    'flags': 'a',
                    'mode': 0o666,
                });
                this.#file.on('error', (error) => {
                    this.#fixClient.connection?.emit('error', error);
                });
                if (this.#fixClient.connection) {
                    this.#fixClient.connection.on('close', () => {
                        this.#file?.close();
                        this.#file = null;
                    });
                }
            }
            this.#file.write(raw + '\n');
        };
        this.#requestResendRequestedSeqNum = 0;
        this.#requestResendTargetSeqNum = 0;
        this.requestResend = (start, target) => {
            this.#requestResendTargetSeqNum = target;
            const batchSize = 2000;
            if (this.#isResendRequested === false && start < this.#requestResendTargetSeqNum) {
                this.#isResendRequested = true;
                const send = (from, to = 0) => this.send({
                    [fixtagnums_1.keyvals.MsgType]: 2,
                    [fixtagnums_1.keyvals.BeginSeqNo]: from,
                    [fixtagnums_1.keyvals.EndSeqNo]: to,
                });
                if (target - start <= batchSize) {
                    this.#requestResendRequestedSeqNum = this.#requestResendTargetSeqNum = 0;
                    send(start);
                }
                else {
                    this.#requestResendRequestedSeqNum = start + batchSize;
                    send(start, this.#requestResendRequestedSeqNum);
                }
            }
        };
        this.resendMessages = (BeginSeqNo = 0, EndSeqNo = this.#session.outgoingSeqNum - 1) => {
            if (this.#logfilename) {
                const reader = fs_1.createReadStream(this.#logfilename, {
                    'flags': 'r',
                    'encoding': 'binary',
                    'mode': 0o666
                });
                const lineReader = readline_1.createInterface({
                    input: reader,
                });
                let fillGapBuffer = [];
                const sendFillGap = () => {
                    if (fillGapBuffer.length > 0) {
                        this.send({
                            [fixtagnums_1.keyvals.MsgType]: '4',
                            [fixtagnums_1.keyvals.OrigSendingTime]: fillGapBuffer[0][fixtagnums_1.keyvals.SendingTime],
                            [fixtagnums_1.keyvals.GapFillFlag]: 'Y',
                            [fixtagnums_1.keyvals.MsgSeqNum]: Number(fillGapBuffer[0][fixtagnums_1.keyvals.MsgSeqNum]),
                            [fixtagnums_1.keyvals.NewSeqNo]: Number(fillGapBuffer[fillGapBuffer.length - 1][fixtagnums_1.keyvals.MsgSeqNum]) + 1,
                        }, true);
                        fillGapBuffer = [];
                    }
                };
                lineReader.on('line', (line) => {
                    const _fix = fixutils_1.convertToMap(line);
                    const _msgType = `${_fix[fixtagnums_1.keyvals.MsgType]}`;
                    const _seqNo = Number(_fix[34]);
                    if ((BeginSeqNo <= _seqNo) && (EndSeqNo >= _seqNo)) {
                        if (['A', '5', '2', '0', '1', '4'].includes(_msgType)) {
                            fillGapBuffer.push(_fix);
                            if (EndSeqNo === _seqNo) {
                                sendFillGap();
                            }
                        }
                        else {
                            sendFillGap();
                            this.send({
                                ..._fix,
                                [fixtagnums_1.keyvals.OrigSendingTime]: _fix[fixtagnums_1.keyvals.SendingTime],
                                [fixtagnums_1.keyvals.PossDupFlag]: 'Y',
                                [fixtagnums_1.keyvals.MsgSeqNum]: _seqNo,
                                [fixtagnums_1.keyvals.NewSeqNo]: _seqNo + 1,
                            }, true);
                        }
                    }
                    else if (EndSeqNo < _seqNo) {
                        sendFillGap();
                        lineReader.removeAllListeners('line');
                        reader.close();
                    }
                });
            }
        };
        this.createsessionStorage = (senderCompID, targetCompID) => {
            this.#key = `${senderCompID}-${targetCompID}`;
            this.#retriveSession = ((senderId, targetId) => {
                this.#key = senderId + '-' + targetId;
                sessions[this.#key] = node_persist_1.default.getItemSync(this.#key) ?? {
                    incomingSeqNum: 1,
                    outgoingSeqNum: 1,
                };
                sessions[this.#key].isLoggedIn = false;
                return sessions[this.#key];
            });
        };
        node_persist_1.default.init({
            dir: options.logFolder ?? './storage'
        });
        this.#fixClient = fixClient;
        this.#isAcceptor = isAcceptor;
        this.#fixVersion = options.fixVersion;
        this.#senderCompID = options.senderCompID;
        this.#senderSubID = options.senderSubID;
        this.#targetCompID = options.targetCompID;
        this.#targetSubID = options.targetSubID;
        this.#senderLocationID = options.senderLocationID;
        this.#retriveSession = () => {
            return {
                incomingSeqNum: 1,
                outgoingSeqNum: 1,
                isLoggedIn: false
            };
        };
        if (options.senderCompID && options.targetCompID) {
            this.createsessionStorage(options.senderCompID, options.targetCompID);
        }
        this.#logFolder = options.logFolder ?? './storage';
        this.#key = `${this.#senderCompID}-${this.#targetCompID}`;
        this.#isDuplicateFunc = options.isDuplicateFunc ?? ((senderId, targetId) => sessions[`${senderId} -${targetId} `]?.isLoggedIn ?? false);
        this.#isAuthenticFunc = options.isAuthenticFunc ?? (() => true);
        this.#resetSeqNumOnReconect = options.resetSeqNumOnReconect ?? true;
        this.#defaultHeartbeatSeconds = options.defaultHeartbeatSeconds ?? '10';
        this.#sendHeartbeats = options.sendHeartbeats ?? true;
        this.#expectHeartbeats = options.expectHeartbeats ?? true;
        this.#respondToLogon = options.respondToLogon ?? true;
    }
    #fixClient;
    #isAcceptor;
    #session;
    #saveSession;
    #timeOfLastIncoming;
    #heartbeatIntervalID;
    #timeOfLastOutgoing;
    #timeOfLastOutgoingHeartbeat;
    #testRequestID;
    #isResendRequested;
    #isLogoutRequested;
    #logfilename;
    #file;
    #requestResendRequestedSeqNum;
    #requestResendTargetSeqNum;
    #fixVersion;
    #senderCompID;
    #senderSubID;
    #targetCompID;
    #targetSubID;
    #appVerID;
    #senderLocationID;
    #logFolder;
    #isDuplicateFunc;
    #isAuthenticFunc;
    #retriveSession;
    #resetSeqNumOnReconect;
    #defaultHeartbeatSeconds;
    #sendHeartbeats;
    #expectHeartbeats;
    #respondToLogon;
    #key;
}
exports.FIXSession = FIXSession;
//# sourceMappingURL=FIXSession.js.map