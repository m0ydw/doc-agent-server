import { setText } from "../../../services/editor";

export async function writeCellTextByRef(docId: string, ref: string, text: string): Promise<string> {
  return setText(docId, ref, text);
}
