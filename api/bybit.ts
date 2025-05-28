import { IExchange } from "../types/exchange";
import { config } from "../vars/config";

import {
  RestClientV5,
  WebsocketClient,
  WSClientConfigurableOptions
} from "bybit-api";

import { logger } from "../services/logger";
import { error } from "console";

interface TypedWebsocketClient extends WebsocketClient {
  on(event: "open", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export class BybitExchange implements IExchange {
  private wsClient: TypedWebsocketClient | null = null;
  private apiKey: string = config.API_KEY;
  private apiSecret: string = config.SECRET_KEY;
  private baseUrl: string = "https://api.bybit.com";
  private wsUrl: string = "wss://stream.bybit.com/realtime";

  private isConnected: boolean = false;
  private connectionPromise: Promise<void> | null = null;
  public client: RestClientV5;

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;

    if (!this.apiKey || !this.apiSecret) {
      throw new Error("API Key and Secret Key problems.");
    }

    this.client = new RestClientV5({
      key: this.apiKey,
      secret: this.apiSecret,
      testnet: false,
      baseUrl: this.baseUrl
    });
  }

  public isWebSocketConnected(): boolean {
    return this.isConnected;
  }
  public connectWebSocket(): void {
    this.isConnected = true;
  }

  public connect(): Promise<void> {
    if (this.isConnected) {
      logger.info("WebSocket уже подключен.");
      return Promise.resolve();
    }

    logger.info("Начинаем процесс подключения WebSocket...");

    this.connectionPromise = new Promise(async (resolve, reject) => {
      let errorHandler: ((error: Error) => void) | undefined = undefined;

      try {
        logger.debug("Создаем WebSocket клиент...");

        const wsConfig: WSClientConfigurableOptions = {
          key: this.apiKey,
          secret: this.apiSecret,
          testnet: false,
          market: "v5"
        };

        this.wsClient = new WebsocketClient(wsConfig);

        errorHandler = (error: Error) => {
          logger.error(
            "[Connect Error Handler] WebSocket error during initial connection:",
            error
          );

          if (errorHandler) {
            this.wsClient?.removeListener("error", errorHandler);
            reject(error);
          }
        };

        this.wsClient.on("error", errorHandler);
        this.wsClient.connectPublic();
      } catch (error) {
        logger.error(
          "[Connect Promise Catch Block] Critical error during WebSocket initialization/connectPublic:",
          error
        );
        this.isConnected = false;
        if (errorHandler && this.wsClient)
          this.wsClient.removeListener("error", errorHandler);
        reject(error);
      }
    });

    return this.connectionPromise;
  }

  async getSymbols(): Promise<string[]> {
    try {
      logger.info("Fetching symbols from Bybit...");
    } catch (error) {}
  }
}
