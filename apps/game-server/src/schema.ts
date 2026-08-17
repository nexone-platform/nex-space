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
}

export class OfficeState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
