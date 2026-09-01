/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import SharePage from "./SharePage";

const Root = location.pathname === "/share" ? SharePage : App;
render(() => <Root />, document.getElementById("root")!);
