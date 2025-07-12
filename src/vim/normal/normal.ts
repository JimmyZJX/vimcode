import { Pos } from "../../editorInterface";
import { Chords } from "../common";
import { motions } from "../motion/motion";

export const normals: Chords<Pos, Pos> = {
  ...motions,
};
