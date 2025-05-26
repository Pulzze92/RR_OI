"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebsocketAPIClient = void 0;
const websocket_util_1 = require("./util/websockets/websocket-util");
const websocket_client_1 = require("./websocket-client");
/**
 * This is a minimal Websocket API wrapper around the WebsocketClient.
 *
 * Some methods support passing in a custom "wsKey". This is a reference to which WS connection should
 * be used to transmit that message. This is only useful if you wish to use an alternative wss
 * domain that is supported by the SDK.
 *
 * Note: To use testnet, don't set the wsKey - use `testnet: true` in
 * the constructor instead.
 *
 * Note: You can also directly use the sendWSAPIRequest() method to make WS API calls, but some
 * may find the below methods slightly more intuitive.
 *
 * Refer to the WS API promises example for a more detailed example on using sendWSAPIRequest() directly:
 * https://github.com/tiagosiebler/bybit-api/blob/master/examples/ws-api-raw-promises.ts
 */
class WebsocketAPIClient {
    constructor(options, logger) {
        this.wsClient = new websocket_client_1.WebsocketClient(options, logger);
        this.options = Object.assign({ attachEventListeners: true }, options);
        this.logger = this.wsClient.logger;
        this.setupDefaultEventListeners();
    }
    getWSClient() {
        return this.wsClient;
    }
    setTimeOffsetMs(newOffset) {
        return this.getWSClient().setTimeOffsetMs(newOffset);
    }
    /*
     * Bybit WebSocket API Methods
     * https://bybit-exchange.github.io/docs/v5/websocket/trade/guideline
     */
    /**
     * Submit a new order
     *
     * @param params
     * @returns
     */
    submitNewOrder(params) {
        return this.wsClient.sendWSAPIRequest(websocket_util_1.WS_KEY_MAP.v5PrivateTrade, 'order.create', params);
    }
    /**
     * Amend an order
     *
     * @param params
     * @returns
     */
    amendOrder(params) {
        return this.wsClient.sendWSAPIRequest(websocket_util_1.WS_KEY_MAP.v5PrivateTrade, 'order.amend', params);
    }
    /**
     * Cancel an order
     *
     * @param params
     * @returns
     */
    cancelOrder(params) {
        return this.wsClient.sendWSAPIRequest(websocket_util_1.WS_KEY_MAP.v5PrivateTrade, 'order.cancel', params);
    }
    /**
     * Batch submit orders
     *
     * @param params
     * @returns
     */
    batchSubmitOrders(category, orders) {
        return this.wsClient.sendWSAPIRequest(websocket_util_1.WS_KEY_MAP.v5PrivateTrade, 'order.create-batch', {
            category,
            request: orders,
        });
    }
    /**
     * Batch amend orders
     *
     * @param params
     * @returns
     */
    batchAmendOrder(category, orders) {
        return this.wsClient.sendWSAPIRequest(websocket_util_1.WS_KEY_MAP.v5PrivateTrade, 'order.amend-batch', {
            category,
            request: orders,
        });
    }
    /**
     * Batch cancel orders
     *
     * @param params
     * @returns
     */
    batchCancelOrder(category, orders) {
        return this.wsClient.sendWSAPIRequest(websocket_util_1.WS_KEY_MAP.v5PrivateTrade, 'order.cancel-batch', {
            category,
            request: orders,
        });
    }
    /**
     *
     *
     *
     *
     *
     *
     *
     * Private methods for handling some of the convenience/automation provided by the WS API Client
     *
     *
     *
     *
     *
     *
     *
     */
    setupDefaultEventListeners() {
        if (this.options.attachEventListeners) {
            /**
             * General event handlers for monitoring the WebsocketClient
             */
            this.wsClient
                .on('open', (data) => {
                console.log(new Date(), 'ws connected', data.wsKey);
            })
                .on('reconnect', ({ wsKey }) => {
                console.log(new Date(), 'ws automatically reconnecting.... ', wsKey);
            })
                .on('reconnected', (data) => {
                console.log(new Date(), 'ws has reconnected ', data === null || data === void 0 ? void 0 : data.wsKey);
            })
                .on('authenticated', (data) => {
                console.info(new Date(), 'ws has authenticated ', data === null || data === void 0 ? void 0 : data.wsKey);
            })
                .on('exception', (data) => {
                console.error(new Date(), 'ws exception: ', JSON.stringify(data));
            });
        }
    }
}
exports.WebsocketAPIClient = WebsocketAPIClient;
//# sourceMappingURL=websocket-api-client.js.map