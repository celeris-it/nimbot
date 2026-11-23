import { mount } from "svelte";
import App from "./App.svelte";
import { applyAppearance, readAppearance } from "./appearance.js";
import "./panel.css";

const initialAppearance = readAppearance();
applyAppearance(initialAppearance);
mount(App, {
  target: document.getElementById("app")!,
  props: { initialAppearance },
});
