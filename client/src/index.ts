import "whatwg-fetch";
import { EventEmitter } from "events";
import { Mutex, MutexInterface } from "async-mutex";
import { debug } from "./debug";

export class Client extends EventEmitter {
    private pc: RTCPeerConnection | undefined;
    private dc: RTCDataChannel | undefined;
    private channelData: ChannelData | undefined;
    private iceCandidates: RTCIceCandidate[];

    private iceCandidateMutex: MutexInterface = new Mutex();
    private iceCandidateMutexRelease: MutexInterface.Releaser | undefined;
    constructor(private readonly address: string) {
        super();

        this.iceCandidates = [];
    }

    public async connect(): Promise<void> {
        this.iceCandidateMutexRelease = await this.iceCandidateMutex.acquire();
        const isUDP = (candidate: RTCIceCandidate) => {
            if (candidate.candidate) {
                return candidate.candidate.includes("UDP");
            }
        };

        this.pc = new RTCPeerConnection({});

        this.pc.onnegotiationneeded = (event: Event) => {
            debug.info("negotation-needed", event);
        };
        this.pc.onicecandidateerror = (event: Event) => {
            debug.info("ice-candidate", event);
        };
        this.pc.onsignalingstatechange = event => {
            if (!this.pc) {
                return;
            }
            debug.info("signaling-state", this.pc.signalingState);
        };
        this.pc.oniceconnectionstatechange = event => {
            if (!this.pc) {
                return;
            }
            debug.info("ice-connection-state", this.pc.iceConnectionState);
        };
        this.pc.onicegatheringstatechange = event => {
            if (!this.pc) {
                return;
            }
            debug.info("ice-gathering-state", this.pc.iceGatheringState);
        };
        this.pc.onconnectionstatechange = event => {
            if (!this.pc) {
                return;
            }
            debug.info("connection-state", this.pc.connectionState);
        };

        this.pc.onicecandidate = (candidate: RTCPeerConnectionIceEvent): void => {
            if (!candidate.candidate) {
                if (!this.iceCandidateMutexRelease) {
                    throw new Error("invalid iceCandidateMutexPromise");
                }
                this.iceCandidateMutexRelease();
            } else {
                const iceCandidate: RTCIceCandidate = candidate.candidate;
                if (isUDP(iceCandidate)) {
                    if (!this.channelData) {
                        throw new Error("invalid channelData");
                    }
                    debug.info(`${this.channelData.channel_id} pc2.onicecandidate (before)`, JSON.stringify(iceCandidate));
                    this.iceCandidates.push(iceCandidate);
                }
            }
        };

        this.pc.ondatachannel = event => {
            this.dc = event.channel;
            this.dc.onopen = () => {
                debug.info("pc2: data channel open");
                this.emit("connected");
                if (!this.dc) {
                    throw new Error("invalid dataChannel");
                }
                this.dc.onmessage = (e: MessageEvent) => {
                    this.emit("data", e.data);
                };
            };
        };

        try {
            const result = await fetch(`http://${this.address}/channels`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                }
            });
            const data: ChannelData = await result.json();
            debug.info("connect", data);
            this.channelData = data;
            this.setRemoteDescription2(data.offer as RTCSessionDescriptionInit);
            data.ice_candidates.forEach(iceCandidate => {
                if (!this.channelData) {
                    throw new Error("invalid channelData");
                }
                debug.info(`${this.channelData.channel_id} adding remote ice candidates`, JSON.stringify(iceCandidate));
                if (!this.pc) {
                    throw new Error("invalid pc");
                }
                this.pc.addIceCandidate(new RTCIceCandidate(iceCandidate as RTCIceCandidateInit));
            });
        } catch (error) {
            this.emit("error", error);
        }
    }

    public send(msg: any): void {
        if (!this.dc) {
            this.emit("error", new Error("dataChannel not available. Not connected?"));
            return;
        }
        this.dc.send(msg);
    }

    private handleError: RTCPeerConnectionErrorCallback = (error: DOMError): void => debug.info("error", error);

    public async stop(): Promise<void> {
        if (!this.channelData) {
            this.emit("error", new Error("channelData is empty. Not connected?"));
            return;
        }

        try {
            const result = await fetch(`http://${this.address}/channels/${this.channelData.channel_id}/close`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                }
            });
            const resultJson = await result.json();

            this.emit("closed");
            if (!this.channelData) {
                throw new Error("invalid channelData");
            }

            debug.info(`${this.channelData.channel_id} closed`, resultJson);
        } catch (error) {
            this.emit("error", error);
        }
    }

    private async setRemoteDescription1(desc: RTCSessionDescription): Promise<void> {
        if (!this.channelData) {
            throw new Error("invalid channelData");
        }
        debug.info(`${this.channelData.channel_id} pc2: set remote description1 (send to node)`, desc.type, desc.sdp);
        try {
            if (!this.iceCandidateMutex) {
                throw new Error("invalid iceCandidateMutex");
            }
            this.iceCandidateMutex.runExclusive(async () => {
                if (!this.channelData) {
                    throw new Error("invalid channelData");
                }
                const result = await fetch(`http://${this.address}/channels/${this.channelData.channel_id}/answer`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        answer: desc,
                        ice_candidates: this.iceCandidates
                    })
                });
                const resultJson = await result.json();
                if (!this.channelData) {
                    throw new Error("invalid channelData");
                }
                debug.info(`${this.channelData.channel_id} setRemoteDescription1`, resultJson);
            });
        } catch (error) {
            this.emit("error", error);
        }
    }

    private setLocalDescription2(desc: RTCSessionDescriptionInit): void {
        if (!this.channelData) {
            throw new Error("invalid channelData");
        }
        debug.info(`${this.channelData.channel_id} pc2: set local description`, desc.type, desc.sdp);
        if (!this.pc) {
            throw new Error("invalid pc");
        }
        this.pc.setLocalDescription(
            new RTCSessionDescription(desc) as RTCSessionDescriptionInit,
            this.setRemoteDescription1.bind(this, desc),
            this.handleError.bind(this)
        );
    }

    private createAnswer2(): void {
        if (!this.channelData) {
            throw new Error("invalid channelData");
        }
        debug.info(`${this.channelData.channel_id} pc2: create answer`);
        if (!this.pc) {
            throw new Error("invalid pc");
        }
        this.pc.createAnswer(this.setLocalDescription2.bind(this), this.handleError.bind(this));
    }

    private setRemoteDescription2(desc: RTCSessionDescriptionInit): void {
        if (!this.channelData) {
            throw new Error("invalid channelData");
        }
        debug.info(`${this.channelData.channel_id} pc2: set remote description`, desc.type, desc.sdp);
        if (!this.pc) {
            throw new Error("invalid pc");
        }
        this.pc.setRemoteDescription(
            new RTCSessionDescription(desc) as RTCSessionDescriptionInit,
            this.createAnswer2.bind(this),
            this.handleError.bind(this)
        );
    }
}
