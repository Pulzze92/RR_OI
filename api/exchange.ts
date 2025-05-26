import CryptoJS from "crypto-js";
import axios from "axios";

import { tradingApiInterface } from "../types/exchange";

export class tradingApi implements tradingApiInterface {
  private apiKey: string;
  private apiSecret: string;

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }
}
