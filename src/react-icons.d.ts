// Type shim for react-icons which is a Decky runtime dep not listed in package.json.
declare module "react-icons/fa" {
  import { FC, SVGAttributes } from "react";
  type IconProps = SVGAttributes<SVGElement> & { size?: string | number; color?: string; title?: string };
  export const FaDownload: FC<IconProps>;
}
