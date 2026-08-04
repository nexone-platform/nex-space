import { Schema, MapSchema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("string") dir = "down";
  @type("boolean") moving = false;
  @type("string") name = "";
  @type("string") avatar = "1";
}

export class OfficeState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
