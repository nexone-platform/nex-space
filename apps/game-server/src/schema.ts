import { Schema, MapSchema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("string") dir = "down";
  @type("boolean") moving = false;
  @type("string") name = "";
  @type("string") avatar = "1";
  @type("string") desk = ""; // id of the desk this player has claimed ("" = none)
  @type("string") status = "online"; // online | afk | muted | meeting
  // The mic is tracked apart from `status` because "meeting" outranks "muted":
  // inside a meeting the status alone can never say whether you can be heard.
  @type("boolean") micOn = false;
  // Raising a hand is a request to speak, so it has to outlive the moment it is
  // sent — a chat message would scroll away.
  @type("boolean") handUp = false;
  // The account behind this player, empty for a guest. Clients need it to start
  // a private thread with someone: a session id is gone the moment they reload,
  // and a thread has to survive that.
  @type("string") userId = "";
  // Which map of the space this player is standing on. A space may hold several
  // — floors of a building, or separate offices — and everybody stays in one
  // room so the roster, private messages and "come over" still reach across
  // them. What does not cross is earshot: proximity is per map.
  @type("string") map = "";
}

/**
 * Something somebody left on the floor.
 *
 * In room state rather than in a message, because the point of a sticker is
 * that it is still there when you walk past later — a message only reaches the
 * people who were already looking. That also means it survives a reload of
 * anybody's browser, and does not survive a restart of this server, which is
 * the right trade for a doodle.
 */
export class Sticker extends Schema {
  @type("string") emoji = "";
  /** world pixels, like a player's position */
  @type("number") x = 0;
  @type("number") y = 0;
  /** which map of the space it is stuck to */
  @type("string") map = "";
  /** who left it, for the tooltip — a name, not an account */
  @type("string") by = "";
  /** when, so the browser can fade the old ones and the server can sweep them */
  @type("number") at = 0;
}

export class OfficeState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Sticker }) stickers = new MapSchema<Sticker>();
}
