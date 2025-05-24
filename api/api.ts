import CryptoJS from "crypto-js";
import axios from "axios";

export class BingxApi {
  private apiKey: string;
  private apiSecret: string;

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }
}
