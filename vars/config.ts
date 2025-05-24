import * as dotenv from "dotenv";

dotenv.config();

export const config = {
  API_KEY: process.env.API_KEY || "",
  SECRET_KEY: process.env.SECRET_KEY || "",
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  TG_CHANNEL_ID: process.env.TG_CHANNEL_ID || ""
};
