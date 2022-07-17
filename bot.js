// ---------------------------------------------------------------------------------- //
// This is a mess. I am sorry. 
// ---------------------------------------------------------------------------------- //


import { ethers } from "ethers";
import * as fs from 'fs';
import 'dotenv/config'
import nervousABI from "./nervous.abi.json" assert {type: "json"};
import winston from 'winston';
import { EventEmitter } from "events";
import yaml from 'yaml-js';
import { TwitterApi, EUploadMimeType } from 'twitter-api-v2';
import * as https from 'https'
import axios from 'axios';
import { WebhookClient, MessageEmbed } from 'discord.js';
import Handlebars from 'handlebars';


// ---------------------------------------------------------------------------------- //
// LOGGING
// ---------------------------------------------------------------------------------- //


const botLogFormat = winston.format.printf(({ level, message, label, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

const botLogLevels = {
  levels: {
    info: 0,
    notice: 1,
    action: 2,
    transaction: 3,
    event: 4,
    error: 5,
    debug: 6
  },
  colors: {
    info: 'blue',
    notice: 'magenta',
    action: 'red',
    transaction: 'greenBG',
    event: 'yellowBG',
    error: 'redBG',
    debug: 'whiteBG'
  }
};

const logger = winston.createLogger({
  levels: botLogLevels.levels,
  format: winston.format.combine(
    winston.format.timestamp(),
    botLogFormat

  ),

  transports: [
    new winston.transports.Console({
      level: 'debug',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        botLogFormat,
      )
    }),

    // new winston.transports.File({
    //   filename: 'bot.log',
    //   level: 'error',
    //   format: winston.format.combine(
    //     winston.format.timestamp(),
    //     botLogFormat,
    //   )
    // })

    // new winston.transports.File({ filename: 'bot.log' })
  ]
});

winston.addColors(botLogLevels.colors);


// ---------------------------------------------------------------------------------- //
// Instantiate variables
// ---------------------------------------------------------------------------------- //
const nervousBotConfig = yaml.load(fs.readFileSync('nervousBot.yaml', 'utf8'));


const chain = parseInt(process.env.CHAINID)
let provider = new ethers.providers.InfuraProvider.getWebSocketProvider(chain, process.env.INFURA_PROJECTID);
const discordWebhook = new WebhookClient({ url: process.env.DISCORD_WEBHOOK });
let nervousProjects = []

class BotEvents extends EventEmitter { }
const botEvents = new BotEvents();

const templateTypes = ['transfer', 'mint']
const templates = {}

templateTypes.forEach(templateType => {
  templates[templateType] = Handlebars.compile(fs.readFileSync(`templates/${templateType}.handlebars`, 'utf8'))
})


// ---------------------------------------------------------------------------------- //
// Publishers
// ---------------------------------------------------------------------------------- //



botEvents.on('PublishConsole', async (payload) => {
  logger.info(`Publishing to console: ${payload.transactionHash}`)
  const message = getMessage(payload)
  console.log(message)
  // console.log(payload)
});

botEvents.on('PublishTwitter', async (payload) => {
  logger.info(`Publishing to Twitter: ${payload.transactionHash}`)
  // payload.hashtags = getHashtags(payload)
  const message = getMessage(payload)
  const url = `https://etherscan.io/tx/${payload.transactionHash}`
  
  tweet(`${message} \n\n${url}`, payload.contractAddress, payload.tokenId)

});


botEvents.on('PublishDiscord', async (payload) => {
  logger.info(`Publishing to Discord: ${payload.transactionHash}`)
  const message = getMessage(payload)
  const url = `https://etherscan.io/tx/${payload.transactionHash}`
  discordMessage(message, url, payload.contractAddress, payload.tokenId)
});


botEvents.on('Publish', async (payload) => {
  logger.debug("Handling Publish event for bots")
  const tweet = nervousBotConfig.config.tweet
  const discord = nervousBotConfig.config.discord
  if (tweet){
    botEvents.emit('PublishTwitter', payload)
  } else {
    logger.debug("Not publishing to Twitter")
  }
  if (discord){
    botEvents.emit('PublishDiscord', payload)
  }else {
    logger.debug("Not publishing to discord")
  }

  
  botEvents.emit('PublishConsole', payload)
  
  
});

// ---------------------------------------------------------------------------------- //
// Utilities
// ---------------------------------------------------------------------------------- //

function getMessage(payload) {

  payload.to = payload.to.slice(0, 5)
  payload.from = payload.from.slice(0, 5)
  if (payload.type == 'mint') {
    return templates['mint'](payload)
  }
  if (payload.type == 'transfer') {
    return templates['transfer'](payload)
  }

}

function getHashtags(payload) {
  const hashtags = nervousBotConfig.config.NFTHashtags
  const char = "#"
  if (payload.type == 'mint') {
    hashtags.push('mint')
  }
  if (payload.type == 'transfer') {
    hashtags.push('transfer')
  }
  hashtags.push(payload.contract.Symbol)

  return hashtags.map(word => `${char}${word}`).join(' ')

}

function getContract(contractAddress) {
  // get contract object by contract address from list of contracts

  const contract = nervousProjects.find(contract => contract.Contract === contractAddress)
  return contract
}

// ---------------------------------------------------------------------------------- //
// discord helper
// ---------------------------------------------------------------------------------- //

async function discordMessage(message, url, contractAddress, tokenId) {
  const imageUrl = await getNFTUrl(contractAddress, tokenId)
  const botconfig = nervousBotConfig.config.Discord

  const webhookEmbed = new MessageEmbed({
    "title": message,
    "url": url,
    "image": {
      "url": imageUrl
    }
  })

  discordWebhook.send({
    username: botconfig.name,
    avatarURL: botconfig.avatarUrl,
    embeds: [webhookEmbed],
  })
    .catch(console.error);
}

// ---------------------------------------------------------------------------------- //
// twitter helper
// ---------------------------------------------------------------------------------- //

async function tweet(message, contractAddress, tokenId) {
  const userClient = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  });

  const nftImageRaw = await getNFTImage(contractAddress, tokenId)
  if (nftImageRaw) {
    const mediaId = await userClient.v1.uploadMedia(Buffer.from(nftImageRaw), { mimeType: EUploadMimeType.Png });
    const newTweet = await userClient.v1.tweet(message, { media_ids: mediaId });
  } else {
    console.error('No image found')
    const newTweet = await userClient.v1.tweet(message);
  }
}

// ---------------------------------------------------------------------------------- //
// NFT Helper
// ---------------------------------------------------------------------------------- //

async function getNFTMetadata(contractAddress, tokenId) {
  try {
    const url = `https://api.opensea.io/api/v1/asset/${contractAddress}/${tokenId}/?include_orders=false`
    console.log(url)
    const resp = await axios.get(url, {
      headers: { "X-API-KEY": process.env.OPENSEA_APIKEY }
    });
    const metadata = resp.data;
    return metadata
  } catch (e) {
    // console.error(e)
    return null
  }
}

async function getNFTUrl(contractAddress, tokenId) {
  const metadata = await getNFTMetadata(contractAddress, tokenId)
  if (metadata) {
    return metadata.image_url
  }
  return null
}

async function getNFTImage(contractAddress, tokenId) {
  const imageUrl = await getNFTUrl(contractAddress, tokenId)
  if (imageUrl) {
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer'
    })

    const image = imageResponse.data
    return image
  }
  return null

}




// ---------------------------------------------------------------------------------- //
// Event Handler
// ---------------------------------------------------------------------------------- //


async function handleTransferEvent(from, to, tokenId, details) {
  logger.info(`HANDLER: ${from} transferred ${tokenId} to ${to}`);
  // logger.info(`hash: ${details.transactionHash}`);
  // logger.info(`${details}`);
  // console.log(details)
  let type = "transfer"
  const contract = getContract(details.address)

  if (from == '0x0000000000000000000000000000000000000000') {
    type = "mint"
  }

  const payload = {
    from,
    to,
    type,
    tokenId,
    transactionHash: details.transactionHash,
    contractAddress: details.address,
    args: details.args,
    details,
    contract,
    timestamp: new Date()
  }

  if (type == "transfer") {
    payload['fromName'] = await provider.lookupAddress(from);
  }

  payload['toName'] = await provider.lookupAddress(to);

  botEvents.emit('Publish', payload)
}


// ---------------------------------------------------------------------------------- //
// Runner
// ---------------------------------------------------------------------------------- //

async function run() {


  logger.info("---------------------------------------------------------------------------------")
  try {
    logger.info("Loading bot config")

    nervousProjects = nervousBotConfig.projects
    logger.info(`Loaded ${nervousProjects.length} projects`)
  } catch (e) {
    console.log(e);
  }

  logger.info('                                                                           ');
  logger.info("---------------------------------------------------------------------------------")
  logger.info("Starting...")
  logger.info('')
  logger.info('')


  const projects = [];

  nervousProjects.forEach((project) => {
    logger.debug(`${project.Name}`)
    logger.debug(`Twitter: ${project.Twitter}`)
    logger.debug(`Symbol: ${project.Symbol}`)
    logger.debug(`Contract: ${project.Contract}`)
    logger.debug('')
    project.contractInferface = new ethers.Contract(project.Contract, nervousABI, provider);

    project.contractInferface.on("Transfer", handleTransferEvent);

  });
}

run()