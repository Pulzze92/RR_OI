import { AmendOrderParamsV5, BatchAmendOrderParamsV5, BatchAmendOrderResultV5, BatchCancelOrderParamsV5, BatchCancelOrderResultV5, BatchCreateOrderResultV5, BatchOrderParamsV5, BatchOrdersRetExtInfoV5, CancelOrderParamsV5, OrderParamsV5, OrderResultV5 } from './types';
import { WSAPIResponse } from './types/websockets/ws-api';
import { WSClientConfigurableOptions } from './types/websockets/ws-general';
import { DefaultLogger } from './util';
import { WebsocketClient } from './websocket-client';
/**
 * Configurable options specific to only the REST-like WebsocketAPIClient
 */
export interface WSAPIClientConfigurableOptions {
    /**
     * Default: true
     *
     * Attach default event listeners, which will console log any high level
     * events (opened/reconnecting/reconnected/etc).
     *
     * If you disable this, you should set your own event listeners
     * on the embedded WS Client `wsApiClient.getWSClient().on(....)`.
     */
    attachEventListeners: boolean;
}
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
export declare class WebsocketAPIClient {
    private wsClient;
    private logger;
    private options;
    constructor(options?: WSClientConfigurableOptions & Partial<WSAPIClientConfigurableOptions>, logger?: DefaultLogger);
    getWSClient(): WebsocketClient;
    setTimeOffsetMs(newOffset: number): void;
    /**
     * Submit a new order
     *
     * @param params
     * @returns
     */
    submitNewOrder(params: OrderParamsV5): Promise<WSAPIResponse<OrderResultV5, 'order.create'>>;
    /**
     * Amend an order
     *
     * @param params
     * @returns
     */
    amendOrder(params: AmendOrderParamsV5): Promise<WSAPIResponse<OrderResultV5, 'order.amend'>>;
    /**
     * Cancel an order
     *
     * @param params
     * @returns
     */
    cancelOrder(params: CancelOrderParamsV5): Promise<WSAPIResponse<OrderResultV5, 'order.cancel'>>;
    /**
     * Batch submit orders
     *
     * @param params
     * @returns
     */
    batchSubmitOrders(category: 'option' | 'linear', orders: BatchOrderParamsV5[]): Promise<WSAPIResponse<{
        list: BatchCreateOrderResultV5[];
    }, 'order.create-batch', BatchOrdersRetExtInfoV5>>;
    /**
     * Batch amend orders
     *
     * @param params
     * @returns
     */
    batchAmendOrder(category: 'option' | 'linear', orders: BatchAmendOrderParamsV5[]): Promise<WSAPIResponse<{
        list: BatchAmendOrderResultV5[];
    }, 'order.amend-batch', BatchOrdersRetExtInfoV5>>;
    /**
     * Batch cancel orders
     *
     * @param params
     * @returns
     */
    batchCancelOrder(category: 'option' | 'linear', orders: BatchCancelOrderParamsV5[]): Promise<WSAPIResponse<{
        list: BatchCancelOrderResultV5[];
    }, 'order.cancel-batch', BatchOrdersRetExtInfoV5>>;
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
    private setupDefaultEventListeners;
}
