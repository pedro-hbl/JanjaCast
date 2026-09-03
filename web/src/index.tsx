/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import SharePage from "./SharePage";
import TelinhaPage from "./TelinhaPage";

const Root =
  location.pathname === "/share" ? SharePage
  : location.pathname === "/telinha" ? TelinhaPage
  : App;
render(() => <Root />, document.getElementById("root")!);
