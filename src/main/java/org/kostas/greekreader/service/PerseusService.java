package org.kostas.greekreader.service;

import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;

@Service
public class PerseusService {

    private final WebClient scaifeClient;
    private final WebClient scaifeJsonClient;
    private final WebClient perseusClient;

    public PerseusService() {
        this.scaifeClient = WebClient.builder()
                .baseUrl("https://scaife-cts.perseus.org/api/cts")
                .codecs(c -> c.defaultCodecs().maxInMemorySize(10 * 1024 * 1024))
                .build();
        this.scaifeJsonClient = WebClient.builder()
                .baseUrl("https://scaife.perseus.org")
                .codecs(c -> c.defaultCodecs().maxInMemorySize(10 * 1024 * 1024))
                .build();
        this.perseusClient = WebClient.builder()
                .baseUrl("https://www.perseus.tufts.edu/hopper")
                .codecs(c -> c.defaultCodecs().maxInMemorySize(5 * 1024 * 1024))
                .build();
    }

    public String getCapabilities() {
        return scaifeClient.get()
                .uri("?request=GetCapabilities")
                .retrieve()
                .bodyToMono(String.class)
                .block();
    }

    public String getValidReff(String urn, int level) {
        return scaifeClient.get()
                .uri("?request=GetValidReff&urn=" + urn + "&level=" + level)
                .retrieve()
                .bodyToMono(String.class)
                .block();
    }

    public String getPassage(String urn) {
        return scaifeClient.get()
                .uri("?request=GetPassage&urn=" + urn)
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

    public String getScaifeLibrary() {
        return scaifeJsonClient.get()
                .uri("/library/json/")
                .retrieve()
                .bodyToMono(String.class)
                .block();
    }
}
