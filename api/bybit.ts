import { IExchange } from "../types/exchange";
import { config } from "../vars/config";

import { RestClientV5 } from "bybit-api";

import { logger } from "../utils/logger";

export class BybitExchange implements IExchange {
  private apiKey: string = config.API_KEY;
  private apiSecret: string = config.SECRET_KEY;
  private baseUrl: string = "https://api.bybit.com";
  private wsUrl: string = "wss://stream.bybit.com/realtime";

  private isConnected: boolean = false;

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
  }
}
