package org.kostas.greekreader.service;

import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;

@Service
public class PerseusService {

    private final WebClient scaifeClient;
    private final WebClient perseusClient;

    public PerseusService() {
        this.scaifeClient = WebClient.builder()
                .baseUrl("https://scaife.perseus.org")
                .codecs(c -> c.defaultCodecs().maxInMemorySize(20 * 1024 * 1024))
                .build();
        this.perseusClient = WebClient.builder()
                .baseUrl("https://www.perseus.tufts.edu/hopper")
                .codecs(c -> c.defaultCodecs().maxInMemorySize(5 * 1024 * 1024))
                .build();
    }

    public String getLibrary() {
        return scaifeClient.get()
                .uri("/library/json/")
                .retrieve()
                .bodyToMono(String.class)
                .block();
    }

    public String getWorkToc(String urn) {
        return scaifeClient.get()
                .uri("/library/{urn}/json/", urn)
                .retrieve()
                .bodyToMono(String.class)
                .block();
    }

    public String getPassageText(String urn) {
        return scaifeClient.get()
                .uri("/library/passage/{urn}/text/", urn)
                .retrieve()
                .bodyToMono(String.class)
                .block();
    }

    public String getMorphology(String word, String lang) {
        return perseusClient.get()
                .uri("/xmlmorph?lang=" + lang + "&lookup=" + word)
                .retrieve()
                .bodyToMono(String.class)
                .block();
    }

    public String resolveForm(String word, String lang) {
        return perseusClient.get()
                .uri("/resolveform?type=exact&lookup=" + word + "&lang=" + lang)
                .retrieve()
                .bodyToMono(String.class)
                .block();
    }
}
